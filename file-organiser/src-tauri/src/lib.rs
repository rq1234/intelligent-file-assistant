// Modules
mod watcher;  // Import our file watcher module
mod classifier;  // Import AI classifier module
mod db;  // SQLite database module

use db::{ActivityEntry, Correction, Database, DbError};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::Emitter;
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use thiserror::Error;

// Global database instance
static DATABASE: OnceLock<Arc<Database>> = OnceLock::new();

// Track if we've shown the "minimized to tray" notification
static SHOWN_TRAY_HINT: AtomicBool = AtomicBool::new(false);

/// Typed errors for Tauri commands, allowing frontend to distinguish error types
#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", content = "message")]
pub enum CommandError {
    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("File already exists: {0}")]
    DuplicateExists(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("File is in use: {0}")]
    FileInUse(String),

    #[error("Path traversal not allowed")]
    PathTraversal,

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    #[error("IO error: {0}")]
    IoError(String),
}

impl From<std::io::Error> for CommandError {
    fn from(err: std::io::Error) -> Self {
        let msg = err.to_string().to_lowercase();
        if msg.contains("permission denied") || msg.contains("access denied") {
            CommandError::PermissionDenied(err.to_string())
        } else if msg.contains("used by another process") || msg.contains("being used") {
            CommandError::FileInUse(err.to_string())
        } else if msg.contains("not found") || msg.contains("cannot find") {
            CommandError::FileNotFound(err.to_string())
        } else {
            CommandError::IoError(err.to_string())
        }
    }
}

// Tauri automatically converts Serialize types to InvokeError via serde_json
// The #[serde(tag = "type", content = "message")] attribute ensures errors
// serialize to JSON like: {"type": "FileNotFound", "message": "path/to/file"}

#[derive(Debug, Serialize)]
struct FileEntry {
    name: String,
    path: String,
    size: u64,
    modified: u64, // Unix timestamp in seconds
}

#[derive(Debug, Serialize)]
struct FilePreview {
    preview_type: String, // "image", "text", "none"
    content: String,      // base64 data URL for images, text for docs
    error: Option<String>,
}

static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

/// Validate that a path doesn't contain traversal sequences and resolves to a real location.
/// Returns the canonicalized path on success.
fn validate_path(path: &str) -> Result<std::path::PathBuf, CommandError> {
    if path.contains("..") {
        return Err(CommandError::PathTraversal);
    }
    let p = std::path::Path::new(path);
    if !p.exists() {
        // For paths that don't exist yet, canonicalize the parent
        if let Some(parent) = p.parent() {
            if parent.exists() {
                let canonical_parent = parent.canonicalize()
                    .map_err(|e| CommandError::InvalidPath(format!("Failed to resolve path: {}", e)))?;
                if canonical_parent.to_string_lossy().contains("..") {
                    return Err(CommandError::PathTraversal);
                }
                return Ok(canonical_parent.join(p.file_name().unwrap_or_default()));
            }
        }
        // Parent doesn't exist either — just do the string check
        return Ok(p.to_path_buf());
    }
    let canonical = p.canonicalize()
        .map_err(|e| CommandError::InvalidPath(format!("Failed to resolve path: {}", e)))?;
    if canonical.to_string_lossy().contains("..") {
        return Err(CommandError::PathTraversal);
    }
    Ok(canonical)
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Start watching a directory for new files
///
/// Called from frontend with: invoke('start_watching', { path: '/path/to/folder' })
#[tauri::command]
fn start_watching(app_handle: tauri::AppHandle, path: String) -> Result<(), String> {
    println!("[COMMAND] start_watching called with path: {}", path);

    // Prevent starting multiple watchers
    if WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return Err("File watcher is already running".to_string());
    }

    // Validate path exists
    if !std::path::Path::new(&path).exists() {
        WATCHER_STARTED.store(false, Ordering::SeqCst);
        return Err(format!("Path does not exist: {}", path));
    }

    if !std::path::Path::new(&path).is_dir() {
        WATCHER_STARTED.store(false, Ordering::SeqCst);
        return Err(format!("Path is not a directory: {}", path));
    }

    // Start the watcher in background thread
    match watcher::start_watcher(app_handle, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            WATCHER_STARTED.store(false, Ordering::SeqCst);
            Err(e)
        }
    }
}

/// Check if the file watcher is currently running
#[tauri::command]
fn is_watcher_running() -> bool {
    WATCHER_STARTED.load(Ordering::SeqCst)
}

/// Stop the file watcher
#[tauri::command]
fn stop_watching() -> Result<(), String> {
    println!("[COMMAND] stop_watching called");

    if !WATCHER_STARTED.load(Ordering::SeqCst) {
        return Err("File watcher is not running".to_string());
    }

    // Signal the watcher thread to stop
    watcher::signal_stop();

    // Reset the started flag
    WATCHER_STARTED.store(false, Ordering::SeqCst);

    println!("[COMMAND] Watcher stopped");
    Ok(())
}

/// Move a file to a destination folder
///
/// Called from frontend with: invoke('move_file', { sourcePath: '...', destFolder: '...' })
#[tauri::command]
fn move_file(source_path: String, dest_folder: String) -> Result<String, CommandError> {
    use std::fs;

    println!("[COMMAND] move_file: {} -> {}", source_path, dest_folder);

    let source = validate_path(&source_path)?;

    if !source.exists() {
        return Err(CommandError::FileNotFound(source_path));
    }

    if !source.is_file() {
        return Err(CommandError::InvalidPath(format!("Source is not a file: {}", source_path)));
    }

    let dest_dir_validated = validate_path(&dest_folder)?;
    if !dest_dir_validated.exists() {
        fs::create_dir_all(&dest_dir_validated)?;
    }

    let filename = source.file_name()
        .ok_or_else(|| CommandError::InvalidPath("Invalid source file path".to_string()))?;

    let dest_path = dest_dir_validated.join(filename);

    if dest_path.exists() {
        return Err(CommandError::DuplicateExists(dest_path.display().to_string()));
    }

    fs::rename(&source, &dest_path)?;

    println!("[COMMAND] File moved successfully to: {}", dest_path.display());
    Ok(format!("Moved to {}", dest_path.display()))
}

/// Move a file to a destination folder, auto-renaming if a duplicate exists
///
/// Appends _1, _2, etc. to the filename (before extension) until a unique name is found.
/// Called from frontend with: invoke('move_file_with_rename', { sourcePath: '...', destFolder: '...' })
#[tauri::command]
fn move_file_with_rename(source_path: String, dest_folder: String) -> Result<String, CommandError> {
    use std::fs;

    println!("[COMMAND] move_file_with_rename: {} -> {}", source_path, dest_folder);

    let source = validate_path(&source_path)?;
    if !source.exists() {
        return Err(CommandError::FileNotFound(source_path));
    }
    if !source.is_file() {
        return Err(CommandError::InvalidPath(format!("Source is not a file: {}", source_path)));
    }

    let dest_dir = validate_path(&dest_folder)?;
    if !dest_dir.exists() {
        fs::create_dir_all(&dest_dir)?;
    }

    let filename = source.file_name()
        .ok_or_else(|| CommandError::InvalidPath("Invalid source file path".to_string()))?;

    let mut dest_path = dest_dir.join(filename);

    // If file exists, find a unique name with _1, _2, etc.
    if dest_path.exists() {
        let stem = source.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file");
        let ext = source.extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{}", e))
            .unwrap_or_default();

        let mut counter = 1u32;
        loop {
            let new_name = format!("{}_{}{}", stem, counter, ext);
            dest_path = dest_dir.join(&new_name);
            if !dest_path.exists() {
                break;
            }
            counter += 1;
            if counter > 9999 {
                return Err(CommandError::IoError("Too many duplicate files at destination".to_string()));
            }
        }
    }

    fs::rename(&source, &dest_path)?;

    println!("[COMMAND] File moved (with rename) to: {}", dest_path.display());
    Ok(format!("Moved to {}", dest_path.display()))
}

/// Classify a file using AI
///
/// Called from frontend with: invoke('classify_file', { filename: '...', availableFolders: [...], correctionHistory: [...] })
#[tauri::command]
async fn classify_file(
    filename: String,
    available_folders: Vec<String>,
    correction_history: Vec<String>,
) -> Result<classifier::Classification, String> {
    println!("[COMMAND] classify_file: {} (with {} corrections)", filename, correction_history.len());

    classifier::classify_file(filename, available_folders, correction_history).await
}

/// Classify an image file using OCR text extraction + GPT-3.5 (cheap path)
///
/// Extracts text from image using Tesseract OCR, then classifies with GPT-3.5.
/// Returns error if OCR extracts too little text (caller should fall back to vision).
#[tauri::command]
async fn classify_image_with_ocr(
    file_path: String,
    filename: String,
    available_folders: Vec<String>,
    correction_history: Vec<String>,
) -> Result<classifier::Classification, String> {
    println!("[COMMAND] classify_image_with_ocr: {} (OCR mode)", filename);

    // Extract text using Tesseract OCR
    let text_content = classifier::extract_image_text(&file_path)?;

    // If OCR extracted too little text, signal caller to use vision fallback
    if text_content.len() < 20 {
        return Err("OCR_INSUFFICIENT_TEXT".to_string());
    }

    println!("[COMMAND] OCR extracted {} chars from {}", text_content.len(), filename);

    classifier::classify_with_text_content(filename, text_content, available_folders, correction_history).await
}

/// Classify an image file using GPT-4o vision (reads actual image content)
///
/// Called from frontend with: invoke('classify_image_file', { filePath: '...', filename: '...', availableFolders: [...], correctionHistory: [...] })
#[tauri::command]
async fn classify_image_file(
    file_path: String,
    filename: String,
    available_folders: Vec<String>,
    correction_history: Vec<String>,
) -> Result<classifier::Classification, String> {
    println!("[COMMAND] classify_image_file: {} (vision mode)", filename);

    classifier::classify_image_file(file_path, filename, available_folders, correction_history).await
}

/// Classify a file using extracted text content (second pass for PDFs, etc.)
///
/// Called from frontend with: invoke('classify_with_content', { filePath: '...', filename: '...', availableFolders: [...], correctionHistory: [...] })
#[tauri::command]
async fn classify_with_content(
    file_path: String,
    filename: String,
    available_folders: Vec<String>,
    correction_history: Vec<String>,
) -> Result<classifier::Classification, String> {
    println!("[COMMAND] classify_with_content: {} (content extraction mode)", filename);

    // Determine file type and extract text
    let ext = file_path.rsplit('.').next().unwrap_or("").to_lowercase();

    let text_content = match ext.as_str() {
        "pdf" => {
            classifier::extract_pdf_text(&file_path)?
        }
        "txt" | "md" | "csv" => {
            // Read first 500 chars of plain text files
            let content = std::fs::read_to_string(&file_path)
                .map_err(|e| format!("Failed to read text file: {}", e))?;
            content.chars().take(500).collect()
        }
        _ => {
            return Err(format!("Unsupported file type for content extraction: .{}", ext));
        }
    };

    if text_content.trim().is_empty() {
        return Err("No text content could be extracted from the file".to_string());
    }

    classifier::classify_with_text_content(filename, text_content, available_folders, correction_history).await
}

/// Scan a directory and return list of subdirectories
///
/// Called from frontend with: invoke('scan_folders', { path: '...' })
#[tauri::command]
fn scan_folders(path: String) -> Result<Vec<String>, String> {
    use std::fs;
    use std::path::Path;

    println!("[COMMAND] scan_folders: {}", path);

    let dir = Path::new(&path);

    if !dir.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if !dir.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut folders = Vec::new();

    match fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries {
                if let Ok(entry) = entry {
                    let path = entry.path();
                    if path.is_dir() {
                        if let Some(folder_name) = path.file_name() {
                            if let Some(name_str) = folder_name.to_str() {
                                folders.push(name_str.to_string());
                            }
                        }
                    }
                }
            }
        }
        Err(e) => return Err(format!("Failed to read directory: {}", e)),
    }

    folders.sort();
    println!("[COMMAND] Found {} folders", folders.len());
    Ok(folders)
}

/// Get a preview of a file's content
///
/// For images: returns base64-encoded thumbnail data URL
/// For PDFs: returns extracted text (first ~200 chars)
/// For text files: returns first ~200 chars
#[tauri::command]
fn get_file_preview(file_path: String) -> Result<FilePreview, String> {
    use base64::Engine;

    let ext = file_path.rsplit('.').next().unwrap_or("").to_lowercase();

    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => {
            // Read image and base64 encode for thumbnail
            let bytes = std::fs::read(&file_path)
                .map_err(|e| format!("Failed to read image: {}", e))?;

            // Skip files larger than 5MB for preview
            if bytes.len() > 5 * 1024 * 1024 {
                return Ok(FilePreview {
                    preview_type: "image".to_string(),
                    content: String::new(),
                    error: Some("File too large for preview".to_string()),
                });
            }

            let mime = match ext.as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                "bmp" => "image/bmp",
                _ => "image/png",
            };

            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Ok(FilePreview {
                preview_type: "image".to_string(),
                content: format!("data:{};base64,{}", mime, b64),
                error: None,
            })
        }
        "pdf" => {
            match classifier::extract_pdf_text(&file_path) {
                Ok(text) => {
                    let preview: String = text.chars().take(200).collect();
                    Ok(FilePreview {
                        preview_type: "text".to_string(),
                        content: preview,
                        error: None,
                    })
                }
                Err(e) => Ok(FilePreview {
                    preview_type: "text".to_string(),
                    content: String::new(),
                    error: Some(e),
                }),
            }
        }
        "txt" | "md" | "csv" => {
            match std::fs::read_to_string(&file_path) {
                Ok(text) => {
                    let preview: String = text.chars().take(200).collect();
                    Ok(FilePreview {
                        preview_type: "text".to_string(),
                        content: preview,
                        error: None,
                    })
                }
                Err(e) => Ok(FilePreview {
                    preview_type: "text".to_string(),
                    content: String::new(),
                    error: Some(format!("Failed to read: {}", e)),
                }),
            }
        }
        _ => {
            Ok(FilePreview {
                preview_type: "none".to_string(),
                content: String::new(),
                error: None,
            })
        }
    }
}

/// Scan a directory and return list of files (not directories)
///
/// Called from frontend with: invoke('scan_files', { path: '...' })
#[tauri::command]
fn scan_files(path: String) -> Result<Vec<FileEntry>, String> {
    use std::fs;
    use std::path::Path;
    use std::time::UNIX_EPOCH;

    println!("[COMMAND] scan_files: {}", path);

    let dir = Path::new(&path);

    if !dir.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if !dir.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut files = Vec::new();

    match fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries {
                if let Ok(entry) = entry {
                    let entry_path = entry.path();
                    if entry_path.is_file() {
                        if let Some(file_name) = entry_path.file_name() {
                            if let Some(name_str) = file_name.to_str() {
                                // Skip hidden files
                                if name_str.starts_with('.') {
                                    continue;
                                }
                                let metadata = entry.metadata().ok();
                                let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                                let modified = metadata
                                    .and_then(|m| m.modified().ok())
                                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                                    .map(|d| d.as_secs())
                                    .unwrap_or(0);
                                files.push(FileEntry {
                                    name: name_str.to_string(),
                                    path: entry_path.to_string_lossy().to_string(),
                                    size,
                                    modified,
                                });
                            }
                        }
                    }
                }
            }
        }
        Err(e) => return Err(format!("Failed to read directory: {}", e)),
    }

    // Sort by modification time, most recent first
    files.sort_by(|a, b| b.modified.cmp(&a.modified));
    println!("[COMMAND] Found {} files", files.len());
    Ok(files)
}

/// Undo a file move - move it back from destination to original source folder
///
/// Called from frontend with: invoke('undo_move', { filePath: '...', originalFolder: '...' })
#[tauri::command]
fn undo_move(file_path: String, original_folder: String) -> Result<String, CommandError> {
    use std::fs;
    use std::path::Path;

    println!("[COMMAND] undo_move: {} -> {}", file_path, original_folder);

    let source = validate_path(&file_path)?;
    let _ = validate_path(&original_folder)?;

    if !source.exists() {
        return Err(CommandError::FileNotFound(file_path));
    }

    if !source.is_file() {
        return Err(CommandError::InvalidPath(format!("Path is not a file: {}", file_path)));
    }

    let dest_dir = Path::new(&original_folder);
    if !dest_dir.exists() {
        fs::create_dir_all(&dest_dir)?;
    }

    let filename = source.file_name()
        .ok_or_else(|| CommandError::InvalidPath("Invalid file path".to_string()))?;

    let dest_path = dest_dir.join(filename);

    if dest_path.exists() {
        return Err(CommandError::DuplicateExists(dest_path.display().to_string()));
    }

    fs::rename(&source, &dest_path)?;

    println!("[COMMAND] Undo successful, file restored to: {}", dest_path.display());
    Ok(format!("Restored to {}", dest_path.display()))
}

/// Send a file to the system recycle bin (recoverable delete)
///
/// Called from frontend with: invoke('trash_file', { filePath: '...' })
#[tauri::command]
fn trash_file(file_path: String) -> Result<String, CommandError> {
    println!("[COMMAND] trash_file: {}", file_path);

    let path = validate_path(&file_path)?;
    if !path.exists() {
        return Err(CommandError::FileNotFound(file_path));
    }
    if !path.is_file() {
        return Err(CommandError::InvalidPath(format!("Path is not a file: {}", file_path)));
    }

    trash::delete(&path)
        .map_err(|e| CommandError::IoError(format!("Failed to move to recycle bin: {}", e)))?;

    println!("[COMMAND] File sent to recycle bin: {}", file_path);
    Ok(format!("Sent to recycle bin"))
}

/// Rename a file in place (same directory, new name)
///
/// Called from frontend with: invoke('rename_file', { filePath: '...', newName: '...' })
#[tauri::command]
fn rename_file(file_path: String, new_name: String) -> Result<String, CommandError> {
    use std::fs;
    use std::path::Path;

    println!("[COMMAND] rename_file: {} -> {}", file_path, new_name);

    let _ = validate_path(&file_path)?;
    if new_name.contains("..") {
        return Err(CommandError::PathTraversal);
    }
    if new_name.contains('/') || new_name.contains('\\') {
        return Err(CommandError::InvalidPath("New name cannot contain path separators".to_string()));
    }
    let invalid_chars = ['<', '>', ':', '"', '|', '?', '*'];
    if new_name.chars().any(|c| invalid_chars.contains(&c)) {
        return Err(CommandError::InvalidPath("New name contains invalid characters".to_string()));
    }
    if new_name.trim().is_empty() {
        return Err(CommandError::InvalidPath("New name cannot be empty".to_string()));
    }

    let source = Path::new(&file_path);
    if !source.exists() {
        return Err(CommandError::FileNotFound(file_path));
    }
    if !source.is_file() {
        return Err(CommandError::InvalidPath(format!("Path is not a file: {}", file_path)));
    }

    let parent = source.parent()
        .ok_or_else(|| CommandError::InvalidPath("Cannot determine parent directory".to_string()))?;
    let new_path = parent.join(&new_name);

    if new_path.exists() {
        return Err(CommandError::DuplicateExists(new_name));
    }

    fs::rename(&source, &new_path)?;

    let new_path_str = new_path.to_string_lossy().to_string();
    println!("[COMMAND] File renamed to: {}", new_path_str);
    Ok(new_path_str)
}

/// Create a folder if it doesn't exist
///
/// Called from frontend with: invoke('create_folder', { path: '...' })
#[tauri::command]
fn create_folder(path: String) -> Result<String, CommandError> {
    use std::fs;

    println!("[COMMAND] create_folder: {}", path);

    let _ = validate_path(&path)?;

    fs::create_dir_all(&path)?;
    Ok(format!("Folder created: {}", path))
}

// ============================================================
// DATABASE COMMANDS
// ============================================================

/// Get the database instance
fn get_db() -> Result<Arc<Database>, DbError> {
    DATABASE
        .get()
        .cloned()
        .ok_or_else(|| DbError::InitFailed("Database not initialized".to_string()))
}

/// Initialize the database (called during app setup)
fn init_database(app_handle: &tauri::AppHandle) -> Result<(), DbError> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| DbError::InitFailed(format!("Failed to get app data dir: {}", e)))?;

    let db_path = app_data_dir.join("file_organiser.db");
    println!("[DB] Initializing database at: {}", db_path.display());

    let db = Database::new(db_path)?;
    DATABASE
        .set(Arc::new(db))
        .map_err(|_| DbError::InitFailed("Database already initialized".to_string()))?;

    Ok(())
}

/// Helper to get current timestamp in milliseconds
fn current_timestamp_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// Add a correction to the database
#[tauri::command]
fn db_add_correction(
    filename: String,
    ai_suggested: String,
    user_chose: String,
    correction_type: String,
) -> Result<i64, DbError> {
    let db = get_db()?;
    db.add_correction(Correction {
        id: None,
        filename,
        ai_suggested,
        user_chose,
        correction_type,
        created_at: current_timestamp_ms(),
    })
}

/// Get all corrections
#[tauri::command]
fn db_get_corrections() -> Result<Vec<Correction>, DbError> {
    let db = get_db()?;
    db.get_corrections()
}

/// Clear all corrections
#[tauri::command]
fn db_clear_corrections() -> Result<(), DbError> {
    let db = get_db()?;
    db.clear_corrections()
}

/// Add an activity entry
#[tauri::command]
fn db_add_activity(
    filename: String,
    from_folder: String,
    to_folder: String,
) -> Result<i64, DbError> {
    let db = get_db()?;
    db.add_activity(ActivityEntry {
        id: None,
        filename,
        from_folder,
        to_folder,
        undone: false,
        created_at: current_timestamp_ms(),
    })
}

/// Get activity log
#[tauri::command]
fn db_get_activity_log() -> Result<Vec<ActivityEntry>, DbError> {
    let db = get_db()?;
    db.get_activity_log()
}

/// Mark activity as undone
#[tauri::command]
fn db_mark_activity_undone(timestamp: i64) -> Result<bool, DbError> {
    let db = get_db()?;
    db.mark_activity_undone(timestamp)
}

/// Clear activity log
#[tauri::command]
fn db_clear_activity_log() -> Result<(), DbError> {
    let db = get_db()?;
    db.clear_activity_log()
}

/// Import data from localStorage (migration)
#[tauri::command]
fn db_import_from_localstorage(
    corrections: Vec<Correction>,
    activity_log: Vec<ActivityEntry>,
) -> Result<(usize, usize), DbError> {
    let db = get_db()?;
    let corrections_count = db.import_corrections(corrections)?;
    let activity_count = db.import_activity_log(activity_log)?;
    Ok((corrections_count, activity_count))
}

// ============================================================
// TESTS
// ============================================================
#[cfg(test)]
mod tests {
    use std::fs;

    // --- scan_folders tests ---

    #[test]
    fn test_scan_folders_returns_sorted_subdirs() {
        let tmp = std::env::temp_dir().join("fileorg_test_scan");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::create_dir(tmp.join("Zebra")).unwrap();
        fs::create_dir(tmp.join("Alpha")).unwrap();
        fs::create_dir(tmp.join("Middle")).unwrap();

        // Also create a file (should NOT appear in results)
        fs::write(tmp.join("readme.txt"), "hello").unwrap();

        let result = super::scan_folders(tmp.to_string_lossy().to_string()).unwrap();
        assert_eq!(result, vec!["Alpha", "Middle", "Zebra"]);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_scan_folders_empty_dir() {
        let tmp = std::env::temp_dir().join("fileorg_test_scan_empty");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let result = super::scan_folders(tmp.to_string_lossy().to_string()).unwrap();
        assert!(result.is_empty());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_scan_folders_nonexistent_path() {
        let result = super::scan_folders("C:\\nonexistent_path_12345".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Path does not exist"));
    }

    #[test]
    fn test_scan_folders_file_not_dir() {
        let tmp = std::env::temp_dir().join("fileorg_test_scan_file.txt");
        fs::write(&tmp, "not a dir").unwrap();

        let result = super::scan_folders(tmp.to_string_lossy().to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Path is not a directory"));

        let _ = fs::remove_file(&tmp);
    }

    // --- scan_files tests ---

    #[test]
    fn test_scan_files_returns_sorted_by_modified_time() {
        let tmp = std::env::temp_dir().join("fileorg_test_scan_files");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        // Create files with delays to ensure different modification times
        // Note: Windows filesystem timestamp resolution can be coarse, so use longer delays
        fs::write(tmp.join("oldest.txt"), "1").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(tmp.join("middle.txt"), "2").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(tmp.join("newest.txt"), "3").unwrap();
        // Also create a subdirectory (should NOT appear in results)
        fs::create_dir(tmp.join("subfolder")).unwrap();

        let result = super::scan_files(tmp.to_string_lossy().to_string()).unwrap();
        assert_eq!(result.len(), 3);
        // Most recent first
        assert_eq!(result[0].name, "newest.txt");
        assert_eq!(result[2].name, "oldest.txt");
        // Verify modification timestamps are populated and in descending order
        assert!(result[0].modified >= result[1].modified);
        assert!(result[1].modified >= result[2].modified);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_scan_files_skips_hidden() {
        let tmp = std::env::temp_dir().join("fileorg_test_scan_files_hidden");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join(".hidden"), "h").unwrap();
        fs::write(tmp.join("visible.txt"), "v").unwrap();

        let result = super::scan_files(tmp.to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = result.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["visible.txt"]);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_scan_files_empty_dir() {
        let tmp = std::env::temp_dir().join("fileorg_test_scan_files_empty");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let result = super::scan_files(tmp.to_string_lossy().to_string()).unwrap();
        assert!(result.is_empty());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_scan_files_nonexistent_path() {
        let result = super::scan_files("C:\\nonexistent_path_12345".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Path does not exist"));
    }

    #[test]
    fn test_scan_files_has_size() {
        let tmp = std::env::temp_dir().join("fileorg_test_scan_files_size");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("test.txt"), "hello world").unwrap();

        let result = super::scan_files(tmp.to_string_lossy().to_string()).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "test.txt");
        assert!(result[0].size > 0);
        assert!(result[0].path.contains("test.txt"));

        let _ = fs::remove_dir_all(&tmp);
    }

    // --- create_folder tests ---

    #[test]
    fn test_create_folder_new() {
        let tmp = std::env::temp_dir().join("fileorg_test_create").join("nested").join("deep");
        let _ = fs::remove_dir_all(std::env::temp_dir().join("fileorg_test_create"));

        let result = super::create_folder(tmp.to_string_lossy().to_string()).unwrap();
        assert!(result.contains("Folder created"));
        assert!(tmp.exists());

        let _ = fs::remove_dir_all(std::env::temp_dir().join("fileorg_test_create"));
    }

    #[test]
    fn test_create_folder_already_exists() {
        let tmp = std::env::temp_dir().join("fileorg_test_create_exists");
        fs::create_dir_all(&tmp).unwrap();

        // Should succeed even if folder already exists
        let result = super::create_folder(tmp.to_string_lossy().to_string());
        assert!(result.is_ok());

        let _ = fs::remove_dir_all(&tmp);
    }

    // --- move_file tests ---

    #[test]
    fn test_move_file_success() {
        let src_dir = std::env::temp_dir().join("fileorg_test_move_src");
        let dest_dir = std::env::temp_dir().join("fileorg_test_move_dest");
        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dest_dir);
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dest_dir).unwrap();

        let src_file = src_dir.join("test.txt");
        fs::write(&src_file, "hello world").unwrap();

        let result = super::move_file(
            src_file.to_string_lossy().to_string(),
            dest_dir.to_string_lossy().to_string(),
        ).unwrap();

        assert!(result.contains("Moved to"));
        assert!(!src_file.exists());
        assert!(dest_dir.join("test.txt").exists());

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dest_dir);
    }

    #[test]
    fn test_move_file_source_not_found() {
        let result = super::move_file(
            "C:\\nonexistent_12345\\file.txt".to_string(),
            "C:\\some_dest".to_string(),
        );
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), super::CommandError::FileNotFound(_)));
    }

    #[test]
    fn test_move_file_dest_already_exists() {
        let src_dir = std::env::temp_dir().join("fileorg_test_move_dup_src");
        let dest_dir = std::env::temp_dir().join("fileorg_test_move_dup_dest");
        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dest_dir);
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dest_dir).unwrap();

        let src_file = src_dir.join("dup.txt");
        fs::write(&src_file, "source").unwrap();
        fs::write(dest_dir.join("dup.txt"), "already here").unwrap();

        let result = super::move_file(
            src_file.to_string_lossy().to_string(),
            dest_dir.to_string_lossy().to_string(),
        );
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), super::CommandError::DuplicateExists(_)));

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dest_dir);
    }

    #[test]
    fn test_move_file_creates_dest_folder() {
        let src_dir = std::env::temp_dir().join("fileorg_test_move_mkdir_src");
        let dest_dir = std::env::temp_dir().join("fileorg_test_move_mkdir_dest").join("new_folder");
        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(std::env::temp_dir().join("fileorg_test_move_mkdir_dest"));
        fs::create_dir_all(&src_dir).unwrap();

        let src_file = src_dir.join("auto.txt");
        fs::write(&src_file, "data").unwrap();

        let result = super::move_file(
            src_file.to_string_lossy().to_string(),
            dest_dir.to_string_lossy().to_string(),
        ).unwrap();

        assert!(result.contains("Moved to"));
        assert!(dest_dir.join("auto.txt").exists());

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(std::env::temp_dir().join("fileorg_test_move_mkdir_dest"));
    }

    #[test]
    fn test_move_file_source_is_directory() {
        let tmp = std::env::temp_dir().join("fileorg_test_move_dir");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let result = super::move_file(
            tmp.to_string_lossy().to_string(),
            "C:\\some_dest".to_string(),
        );
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), super::CommandError::InvalidPath(_)));

        let _ = fs::remove_dir_all(&tmp);
    }

    // --- move_file_with_rename tests ---

    #[test]
    fn test_move_file_with_rename_no_conflict() {
        let src_dir = std::env::temp_dir().join("fileorg_test_rename_src");
        let dest_dir = std::env::temp_dir().join("fileorg_test_rename_dest");
        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dest_dir);
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dest_dir).unwrap();

        let src_file = src_dir.join("notes.txt");
        fs::write(&src_file, "content").unwrap();

        let result = super::move_file_with_rename(
            src_file.to_string_lossy().to_string(),
            dest_dir.to_string_lossy().to_string(),
        ).unwrap();

        assert!(result.contains("Moved to"));
        assert!(dest_dir.join("notes.txt").exists());
        assert!(!src_file.exists());

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dest_dir);
    }

    #[test]
    fn test_move_file_with_rename_one_conflict() {
        let src_dir = std::env::temp_dir().join("fileorg_test_rename_conflict_src");
        let dest_dir = std::env::temp_dir().join("fileorg_test_rename_conflict_dest");
        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dest_dir);
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dest_dir).unwrap();

        // Create existing file at destination
        fs::write(dest_dir.join("lecture.pdf"), "existing").unwrap();
        let src_file = src_dir.join("lecture.pdf");
        fs::write(&src_file, "new version").unwrap();

        let result = super::move_file_with_rename(
            src_file.to_string_lossy().to_string(),
            dest_dir.to_string_lossy().to_string(),
        ).unwrap();

        assert!(result.contains("Moved to"));
        assert!(dest_dir.join("lecture.pdf").exists()); // original untouched
        assert!(dest_dir.join("lecture_1.pdf").exists()); // renamed
        assert!(!src_file.exists());

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dest_dir);
    }

    #[test]
    fn test_move_file_with_rename_multiple_conflicts() {
        let src_dir = std::env::temp_dir().join("fileorg_test_rename_multi_src");
        let dest_dir = std::env::temp_dir().join("fileorg_test_rename_multi_dest");
        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dest_dir);
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dest_dir).unwrap();

        fs::write(dest_dir.join("doc.txt"), "v0").unwrap();
        fs::write(dest_dir.join("doc_1.txt"), "v1").unwrap();
        fs::write(dest_dir.join("doc_2.txt"), "v2").unwrap();
        let src_file = src_dir.join("doc.txt");
        fs::write(&src_file, "v3").unwrap();

        let result = super::move_file_with_rename(
            src_file.to_string_lossy().to_string(),
            dest_dir.to_string_lossy().to_string(),
        ).unwrap();

        assert!(dest_dir.join("doc_3.txt").exists());
        assert!(result.contains("doc_3.txt"));

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dest_dir);
    }

    #[test]
    fn test_move_file_with_rename_no_extension() {
        let src_dir = std::env::temp_dir().join("fileorg_test_rename_noext_src");
        let dest_dir = std::env::temp_dir().join("fileorg_test_rename_noext_dest");
        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dest_dir);
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dest_dir).unwrap();

        fs::write(dest_dir.join("README"), "existing").unwrap();
        let src_file = src_dir.join("README");
        fs::write(&src_file, "new").unwrap();

        let result = super::move_file_with_rename(
            src_file.to_string_lossy().to_string(),
            dest_dir.to_string_lossy().to_string(),
        ).unwrap();

        assert!(dest_dir.join("README_1").exists());
        assert!(result.contains("README_1"));

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dest_dir);
    }

    // --- undo_move tests ---

    #[test]
    fn test_undo_move_success() {
        let moved_dir = std::env::temp_dir().join("fileorg_test_undo_moved");
        let original_dir = std::env::temp_dir().join("fileorg_test_undo_orig");
        let _ = fs::remove_dir_all(&moved_dir);
        let _ = fs::remove_dir_all(&original_dir);
        fs::create_dir_all(&moved_dir).unwrap();

        let moved_file = moved_dir.join("undoable.txt");
        fs::write(&moved_file, "undo me").unwrap();

        let result = super::undo_move(
            moved_file.to_string_lossy().to_string(),
            original_dir.to_string_lossy().to_string(),
        ).unwrap();

        assert!(result.contains("Restored to"));
        assert!(!moved_file.exists());
        assert!(original_dir.join("undoable.txt").exists());

        let _ = fs::remove_dir_all(&moved_dir);
        let _ = fs::remove_dir_all(&original_dir);
    }

    #[test]
    fn test_undo_move_file_gone() {
        let result = super::undo_move(
            "C:\\nonexistent_12345\\gone.txt".to_string(),
            "C:\\some_dir".to_string(),
        );
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), super::CommandError::FileNotFound(_)));
    }

    #[test]
    fn test_undo_move_conflict_at_original() {
        let moved_dir = std::env::temp_dir().join("fileorg_test_undo_conflict_moved");
        let original_dir = std::env::temp_dir().join("fileorg_test_undo_conflict_orig");
        let _ = fs::remove_dir_all(&moved_dir);
        let _ = fs::remove_dir_all(&original_dir);
        fs::create_dir_all(&moved_dir).unwrap();
        fs::create_dir_all(&original_dir).unwrap();

        let moved_file = moved_dir.join("conflict.txt");
        fs::write(&moved_file, "moved version").unwrap();
        fs::write(original_dir.join("conflict.txt"), "original still here").unwrap();

        let result = super::undo_move(
            moved_file.to_string_lossy().to_string(),
            original_dir.to_string_lossy().to_string(),
        );
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), super::CommandError::DuplicateExists(_)));

        let _ = fs::remove_dir_all(&moved_dir);
        let _ = fs::remove_dir_all(&original_dir);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load environment variables from .env file
    dotenv::dotenv().ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Initialize database
            if let Err(e) = init_database(app.handle()) {
                eprintln!("[DB] Failed to initialize database: {}", e);
                // Don't fail app startup - frontend can fall back to localStorage
            }

            // Build tray menu
            let show_item = MenuItemBuilder::with_id("show", "Show Window").build(app)?;
            let stop_item = MenuItemBuilder::with_id("stop", "Stop Watching").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .items(&[&show_item, &stop_item, &quit_item])
                .build()?;

            // Build system tray icon
            let icon = app.default_window_icon()
                .cloned()
                .unwrap_or_else(|| tauri::image::Image::new(&[], 0, 0));

            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app: &tauri::AppHandle, event: tauri::menu::MenuEvent| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = window.unminimize();
                            }
                        }
                        "stop" => {
                            if WATCHER_STARTED.load(Ordering::SeqCst) {
                                watcher::signal_stop();
                                WATCHER_STARTED.store(false, Ordering::SeqCst);
                                println!("[TRAY] Watcher stopped from tray menu");
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray: &tauri::tray::TrayIcon, event: tauri::tray::TrayIconEvent| {
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.unminimize();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimize to tray instead of closing
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Prevent the window from closing
                api.prevent_close();
                // Hide the window instead
                let _ = window.hide();

                // Show a notification the first time to help the user
                if !SHOWN_TRAY_HINT.swap(true, Ordering::SeqCst) {
                    // First time minimizing - show a helpful notification
                    let app = window.app_handle();
                    if let Some(main_window) = app.get_webview_window("main") {
                        // Emit an event to the frontend to show notification
                        let _ = main_window.emit("tray-hint", "App minimized to system tray. Right-click tray icon to quit.");
                    }
                    println!("[APP] Window hidden to tray. Right-click tray icon to quit.");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            start_watching,
            stop_watching,
            is_watcher_running,
            move_file,
            move_file_with_rename,
            undo_move,
            classify_file,
            classify_image_with_ocr,
            classify_image_file,
            classify_with_content,
            scan_folders,
            scan_files,
            get_file_preview,
            create_folder,
            trash_file,
            rename_file,
            // Database commands
            db_add_correction,
            db_get_corrections,
            db_clear_corrections,
            db_add_activity,
            db_get_activity_log,
            db_mark_activity_undone,
            db_clear_activity_log,
            db_import_from_localstorage
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
