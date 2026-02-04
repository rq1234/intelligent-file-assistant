// Modules
mod watcher;  // Import our file watcher module
mod classifier;  // Import AI classifier module

use std::sync::atomic::{AtomicBool, Ordering};

static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

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

/// Move a file to a destination folder
///
/// Called from frontend with: invoke('move_file', { sourcePath: '...', destFolder: '...' })
#[tauri::command]
fn move_file(source_path: String, dest_folder: String) -> Result<String, String> {
    use std::fs;
    use std::path::Path;

    println!("[COMMAND] move_file: {} -> {}", source_path, dest_folder);

    // Validate paths don't contain path traversal sequences
    if source_path.contains("..") || dest_folder.contains("..") {
        return Err("Path traversal not allowed".to_string());
    }

    let source = Path::new(&source_path);

    // Validate source exists
    if !source.exists() {
        return Err(format!("Source file does not exist: {}", source_path));
    }

    if !source.is_file() {
        return Err(format!("Source is not a file: {}", source_path));
    }

    // Validate destination folder exists
    let dest_dir = Path::new(&dest_folder);
    if !dest_dir.exists() {
        // Create destination folder if it doesn't exist
        fs::create_dir_all(&dest_dir)
            .map_err(|e| format!("Failed to create destination folder: {}", e))?;
    }

    // Get filename from source path
    let filename = source.file_name()
        .ok_or("Invalid source file path")?;

    // Build destination path
    let dest_path = dest_dir.join(filename);

    // Check if file already exists at destination
    if dest_path.exists() {
        return Err(format!("File already exists at destination: {}", dest_path.display()));
    }

    // Move the file
    fs::rename(&source, &dest_path)
        .map_err(|e| format!("Failed to move file: {}", e))?;

    println!("[COMMAND] File moved successfully to: {}", dest_path.display());
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

/// Undo a file move - move it back from destination to original source folder
///
/// Called from frontend with: invoke('undo_move', { filePath: '...', originalFolder: '...' })
#[tauri::command]
fn undo_move(file_path: String, original_folder: String) -> Result<String, String> {
    use std::fs;
    use std::path::Path;

    println!("[COMMAND] undo_move: {} -> {}", file_path, original_folder);

    // Validate paths don't contain path traversal sequences
    if file_path.contains("..") || original_folder.contains("..") {
        return Err("Path traversal not allowed".to_string());
    }

    let source = Path::new(&file_path);

    if !source.exists() {
        return Err(format!("File no longer exists at: {}", file_path));
    }

    if !source.is_file() {
        return Err(format!("Path is not a file: {}", file_path));
    }

    let dest_dir = Path::new(&original_folder);
    if !dest_dir.exists() {
        fs::create_dir_all(&dest_dir)
            .map_err(|e| format!("Failed to create original folder: {}", e))?;
    }

    let filename = source.file_name()
        .ok_or("Invalid file path")?;

    let dest_path = dest_dir.join(filename);

    if dest_path.exists() {
        return Err(format!("File already exists at original location: {}", dest_path.display()));
    }

    fs::rename(&source, &dest_path)
        .map_err(|e| format!("Failed to undo move: {}", e))?;

    println!("[COMMAND] Undo successful, file restored to: {}", dest_path.display());
    Ok(format!("Restored to {}", dest_path.display()))
}

/// Create a folder if it doesn't exist
///
/// Called from frontend with: invoke('create_folder', { path: '...' })
#[tauri::command]
fn create_folder(path: String) -> Result<String, String> {
    use std::fs;

    println!("[COMMAND] create_folder: {}", path);

    // Validate path doesn't contain path traversal sequences
    if path.contains("..") {
        return Err("Path traversal not allowed".to_string());
    }

    match fs::create_dir_all(&path) {
        Ok(_) => Ok(format!("Folder created: {}", path)),
        Err(e) => Err(format!("Failed to create folder: {}", e)),
    }
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
        assert!(result.unwrap_err().contains("Source file does not exist"));
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
        assert!(result.unwrap_err().contains("File already exists at destination"));

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
        assert!(result.unwrap_err().contains("Source is not a file"));

        let _ = fs::remove_dir_all(&tmp);
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
        assert!(result.unwrap_err().contains("File no longer exists"));
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
        assert!(result.unwrap_err().contains("File already exists at original location"));

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
        .invoke_handler(tauri::generate_handler![
            greet,
            start_watching,
            move_file,
            undo_move,
            classify_file,
            classify_image_with_ocr,
            classify_image_file,
            classify_with_content,
            scan_folders,
            create_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
