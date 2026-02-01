// Modules
mod watcher;  // Import our file watcher module

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

    // Validate path exists
    if !std::path::Path::new(&path).exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    // Start the watcher in background thread
    watcher::start_watcher(app_handle, path)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![greet, start_watching])  // Register our new command
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
