// File watcher module for detecting new files in watched directories
// Uses notify crate with debouncing to avoid duplicate events

use notify::{Event, EventKind, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Shared stop signal for the watcher thread
static STOP_SIGNAL: AtomicBool = AtomicBool::new(false);

/// Check if the stop signal has been set
pub fn should_stop() -> bool {
    STOP_SIGNAL.load(Ordering::SeqCst)
}

/// Signal the watcher to stop
pub fn signal_stop() {
    STOP_SIGNAL.store(true, Ordering::SeqCst);
}

/// Reset the stop signal (call before starting a new watcher)
pub fn reset_stop_signal() {
    STOP_SIGNAL.store(false, Ordering::SeqCst);
}

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

    // Reset stop signal before starting
    reset_stop_signal();

    // Spawn background thread so we don't block the main app
    thread::spawn(move || {
        // Create channel for receiving file events
        let (tx, rx) = channel();

        // Create debounced watcher (waits 2 seconds after file stops changing)
        let mut debouncer = match new_debouncer(
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
        ) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[WATCHER] Failed to create file watcher: {}", e);
                return;
            }
        };

        // Start watching the directory (non-recursive - only top level)
        if let Err(e) = debouncer
            .watcher()
            .watch(&PathBuf::from(&watch_path), RecursiveMode::NonRecursive)
        {
            eprintln!("[WATCHER] Failed to watch directory: {}", e);
            return;
        }

        println!("[WATCHER] Watching started successfully");

        // Keep the watcher alive and process events, checking stop signal periodically
        loop {
            if should_stop() {
                println!("[WATCHER] Stop signal received, shutting down");
                break;
            }

            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(event) => {
                    // Process the file event
                    handle_file_event(&app_handle, &event);
                }
                Err(RecvTimeoutError::Timeout) => {
                    // No event — loop back and check stop signal
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    eprintln!("[WATCHER] Channel disconnected");
                    break;
                }
            }
        }

        println!("[WATCHER] Watcher thread exiting");
        // Debouncer is dropped here, which stops the underlying watcher
    });

    Ok(())
}

/// Process a file event and emit to frontend if it's a new file
fn handle_file_event(app_handle: &AppHandle, event: &Event) {
    // Only process Create events to avoid duplicates
    // Note: Some downloads might appear as Modify events, but for v0.1 we ignore those
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
        _ => {
            // Ignore modify, delete, access, etc.
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
    if let Err(e) = app_handle.emit("file-detected", &file_info) {
        eprintln!("[WATCHER] Failed to emit file-detected event: {}", e);
    }
}
