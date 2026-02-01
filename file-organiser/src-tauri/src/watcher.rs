// File watcher module for detecting new files in watched directories
// Uses notify crate with debouncing to avoid duplicate events

use notify::{Event, EventKind, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Information about a detected file
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct FileInfo {
    /// Full path to the file
    pub path: String,
    /// Just the filename (no path)
    pub name: String,
    /// File size in bytes
    pub size: u64,
}

/// Start watching a directory for new files
///
/// This function runs in a background thread and emits events to the frontend
/// when new files are detected.
///
/// # Arguments
/// * `app_handle` - Tauri app handle for emitting events
/// * `watch_path` - Path to directory to watch
///
/// # How it works:
/// 1. Creates a debounced file watcher (waits 2 seconds after last change)
/// 2. Watches for file creation events only (not modifications)
/// 3. When file is stable (no changes for 2s), emits "file-detected" event
/// 4. Frontend receives event and can display the file
pub fn start_watcher(app_handle: AppHandle, watch_path: String) -> Result<(), String> {
    println!("[WATCHER] Starting to watch: {}", watch_path);

    // Spawn background thread so we don't block the main app
    thread::spawn(move || {
        // Create channel for receiving file events
        let (tx, rx) = channel();

        // Create debounced watcher (waits 2 seconds after file stops changing)
        let mut debouncer = new_debouncer(
            Duration::from_secs(2),
            None, // No tick rate
            move |result: DebounceEventResult| {
                // This closure runs when a file event occurs
                match result {
                    Ok(events) => {
                        // Send events through channel
                        for event in events {
                            tx.send(event).ok();
                        }
                    }
                    Err(errors) => {
                        for error in errors {
                            eprintln!("[WATCHER] Error: {:?}", error);
                        }
                    }
                }
            },
        )
        .map_err(|e| format!("Failed to create watcher: {}", e))
        .expect("Could not create file watcher");

        // Start watching the directory (non-recursive - only top level)
        debouncer
            .watcher()
            .watch(&PathBuf::from(&watch_path), RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch directory: {}", e))
            .expect("Could not watch directory");

        println!("[WATCHER] Watching started successfully");

        // Keep the watcher alive and process events
        loop {
            match rx.recv() {
                Ok(event) => {
                    // Process the file event
                    handle_file_event(&app_handle, &event);
                }
                Err(e) => {
                    eprintln!("[WATCHER] Channel error: {}", e);
                    break;
                }
            }
        }
    });

    Ok(())
}

/// Process a file event and emit to frontend if it's a new file
fn handle_file_event(app_handle: &AppHandle, event: &Event) {
    // We only care about file creation events
    match event.kind {
        EventKind::Create(_) => {
            // File was created
            for path in &event.paths {
                // Only process files, not directories
                if path.is_file() {
                    process_new_file(app_handle, path);
                }
            }
        }
        EventKind::Modify(_) => {
            // File was modified - we might want this for detecting when
            // file finishes downloading (size stops changing)
            for path in &event.paths {
                if path.is_file() {
                    // For now, we also treat modifications as potential new files
                    // This catches files that are being downloaded/written
                    // The debouncer ensures we only get notified when file is stable
                    process_new_file(app_handle, path);
                }
            }
        }
        _ => {
            // Ignore other events (delete, access, etc.)
        }
    }
}

/// Process a newly detected file and emit event to frontend
fn process_new_file(app_handle: &AppHandle, path: &PathBuf) {
    // Extract filename
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    // Get file size
    let size = std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Create file info struct
    let file_info = FileInfo {
        path: path.to_string_lossy().to_string(),
        name: filename.clone(),
        size,
    };

    println!("[WATCHER] Detected file: {} ({} bytes)", filename, size);

    // Emit event to frontend
    app_handle
        .emit("file-detected", &file_info)
        .expect("Failed to emit file-detected event");
}
