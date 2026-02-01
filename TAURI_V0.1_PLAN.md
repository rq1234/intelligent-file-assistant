# Tauri v0.1 Development Plan

## ✅ Completed

### 1. Repository Reorganization
```
intelligent-file-assistant/
├── python-prototype/       ✅ Python CLI moved here
│   ├── agent/
│   ├── watcher/
│   ├── main.py
│   └── README.md
├── README.md               ✅ Updated root documentation
├── TAURI_SETUP.md          ✅ Created setup guide
└── .gitignore              ✅ Updated for Tauri
```

### 2. Git Branch Strategy
```bash
main                        # Stable Python prototype
  └── feature/tauri-v0.1   ✅ Current branch for Tauri development
```

## 📋 Next Steps

### Step 1: Install Prerequisites ⏳

**You need to install:**
1. **Rust** - Backend language
   ```powershell
   Invoke-WebRequest -Uri https://win.rustup.rs -OutFile rustup-init.exe
   .\rustup-init.exe
   ```

2. **Microsoft C++ Build Tools** - Required for Windows compilation
   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools
   ```
   Select: "Desktop development with C++"

3. **Verify installation:**
   ```bash
   rustc --version
   cargo --version
   ```

See `TAURI_SETUP.md` for detailed instructions.

### Step 2: Create Tauri App Scaffold 📱

After Rust is installed:

```bash
# From repository root
npm create tauri-app@latest

# Choices:
# - Project name: tauri-app
# - Choose UI: React (TypeScript)
# - Package manager: npm
```

This creates:
```
tauri-app/
├── src-tauri/              # Rust backend
│   ├── src/
│   │   └── main.rs         # Entry point
│   ├── Cargo.toml          # Dependencies
│   └── tauri.conf.json     # Configuration
├── src/                    # React frontend
│   ├── App.tsx
│   ├── main.tsx
│   └── components/
├── package.json
└── vite.config.ts          # Build configuration
```

### Step 3: Verify Setup ✓

```bash
cd tauri-app
npm install
npm run tauri dev
```

Expected outcome:
- Compilation starts (~5-10 min first time)
- React dev server starts
- Desktop window opens
- You see default Tauri template

## 🎯 v0.1 Features to Build

### Feature 1: File Watcher (Rust Backend)

**File:** `src-tauri/src/watcher.rs`

```rust
use notify::{Watcher, RecursiveMode, Result};
use std::sync::mpsc::channel;
use std::path::Path;

pub fn start_watcher(path: &str) -> Result<()> {
    let (tx, rx) = channel();
    let mut watcher = notify::watcher(tx, Duration::from_secs(2))?;

    watcher.watch(Path::new(path), RecursiveMode::NonRecursive)?;

    loop {
        match rx.recv() {
            Ok(event) => {
                // Emit event to frontend
                println!("File detected: {:?}", event);
            },
            Err(e) => println!("Watch error: {:?}", e),
        }
    }
}
```

**Dependencies to add** (`Cargo.toml`):
```toml
[dependencies]
notify = "6.1"
```

### Feature 2: Settings UI (React Frontend)

**File:** `src/components/Settings.tsx`

```typescript
import { useState } from 'react'
import { invoke } from '@tauri-apps/api'
import { open } from '@tauri-apps/api/dialog'

export function Settings() {
  const [watchPath, setWatchPath] = useState('')
  const [isWatching, setIsWatching] = useState(false)

  const selectFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
    })
    if (selected) setWatchPath(selected as string)
  }

  const startWatching = async () => {
    await invoke('start_file_watcher', { path: watchPath })
    setIsWatching(true)
  }

  return (
    <div className="settings">
      <h2>File Organizer Settings</h2>

      <div className="setting-group">
        <label>Watch Folder:</label>
        <input value={watchPath} readOnly />
        <button onClick={selectFolder}>Browse...</button>
      </div>

      <button
        onClick={startWatching}
        disabled={!watchPath || isWatching}
      >
        {isWatching ? 'Watching...' : 'Start Watching'}
      </button>
    </div>
  )
}
```

### Feature 3: File List & Manual Classification

**File:** `src/components/FileList.tsx`

```typescript
import { useState, useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api'

interface DetectedFile {
  path: string
  name: string
  size: number
}

export function FileList() {
  const [files, setFiles] = useState<DetectedFile[]>([])
  const [selectedFolder, setSelectedFolder] = useState('')

  useEffect(() => {
    // Listen for file detection events from Rust
    const unlisten = listen('file-detected', (event) => {
      setFiles(prev => [...prev, event.payload as DetectedFile])
    })

    return () => { unlisten.then(fn => fn()) }
  }, [])

  const moveFile = async (filePath: string) => {
    if (!selectedFolder) return

    try {
      await invoke('move_file', {
        sourcePath: filePath,
        destFolder: selectedFolder
      })
      // Remove from list
      setFiles(prev => prev.filter(f => f.path !== filePath))
    } catch (error) {
      alert(`Failed to move file: ${error}`)
    }
  }

  return (
    <div className="file-list">
      <h3>Detected Files ({files.length})</h3>

      {files.map(file => (
        <div key={file.path} className="file-item">
          <div className="file-info">
            <strong>{file.name}</strong>
            <small>{(file.size / 1024).toFixed(1)} KB</small>
          </div>

          <select
            value={selectedFolder}
            onChange={(e) => setSelectedFolder(e.target.value)}
          >
            <option value="">Choose folder...</option>
            <option value="/Documents/Work">Work</option>
            <option value="/Documents/Personal">Personal</option>
          </select>

          <button onClick={() => moveFile(file.path)}>
            Move
          </button>
        </div>
      ))}
    </div>
  )
}
```

### Feature 4: Rust Commands

**File:** `src-tauri/src/main.rs`

```rust
use std::fs;
use std::path::Path;

#[tauri::command]
fn start_file_watcher(app_handle: tauri::AppHandle, path: String) -> Result<(), String> {
    // Start watcher in background thread
    std::thread::spawn(move || {
        // File watching logic here
        // When file detected:
        app_handle.emit_all("file-detected", FileInfo {
            path: "path/to/file",
            name: "file.pdf",
            size: 1024,
        }).unwrap();
    });

    Ok(())
}

#[tauri::command]
fn move_file(source_path: String, dest_folder: String) -> Result<String, String> {
    let source = Path::new(&source_path);
    let filename = source.file_name()
        .ok_or("Invalid file path")?;

    let dest = Path::new(&dest_folder).join(filename);

    fs::rename(&source, &dest)
        .map_err(|e| format!("Failed to move file: {}", e))?;

    Ok(format!("Moved to {}", dest.display()))
}

#[derive(Clone, serde::Serialize)]
struct FileInfo {
    path: String,
    name: String,
    size: u64,
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            start_file_watcher,
            move_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### Feature 5: System Tray

**File:** `src-tauri/src/main.rs` (add to main())

```rust
use tauri::{CustomMenuItem, SystemTray, SystemTrayMenu, SystemTrayEvent};
use tauri::Manager;

fn main() {
    let quit = CustomMenuItem::new("quit".to_string(), "Quit");
    let show = CustomMenuItem::new("show".to_string(), "Show Window");

    let tray_menu = SystemTrayMenu::new()
        .add_item(show)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);

    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::MenuItemClick { id, .. } => {
                match id.as_str() {
                    "quit" => {
                        std::process::exit(0);
                    }
                    "show" => {
                        let window = app.get_window("main").unwrap();
                        window.show().unwrap();
                    }
                    _ => {}
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![...])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## 📊 Development Workflow

### Daily Development Loop

```bash
# 1. Make changes to code
# Edit src/App.tsx or src-tauri/src/main.rs

# 2. Run dev server
npm run tauri dev

# Frontend (React) changes → Hot reload (instant)
# Backend (Rust) changes → Recompile (~10 seconds)

# 3. Test in app window

# 4. Commit changes
git add -A
git commit -m "Add feature X"
```

### Testing Strategy

**Manual Testing:**
1. Open app
2. Select Downloads folder
3. Drop test file into Downloads
4. Verify notification appears
5. Choose destination folder
6. Click "Move"
7. Verify file moved successfully

**Automated Testing (v0.2+):**
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_file_move() {
        // Create temp file
        // Call move_file()
        // Assert file exists at destination
    }
}
```

## 🎨 UI Design (Simple MVP)

```
┌─────────────────────────────────────┐
│ File Organizer              [_][□][X]│
├─────────────────────────────────────┤
│                                     │
│  Settings                           │
│  ┌───────────────────────────────┐  │
│  │ Watch Folder:                 │  │
│  │ C:\Users\You\Downloads  [...]│  │
│  │                               │  │
│  │ [Start Watching]              │  │
│  └───────────────────────────────┘  │
│                                     │
│  Detected Files (3)                 │
│  ┌───────────────────────────────┐  │
│  │ report.pdf  [Documents ▾][Move]│  │
│  │ photo.jpg   [Pictures  ▾][Move]│  │
│  │ code.zip    [Archives  ▾][Move]│  │
│  └───────────────────────────────┘  │
│                                     │
└─────────────────────────────────────┘
```

## ⏱️ Estimated Timeline

- **Setup (Rust install):** 30 minutes
- **Create Tauri app:** 15 minutes
- **Feature 1 (File Watcher):** 2-3 hours
- **Feature 2 (Settings UI):** 1-2 hours
- **Feature 3 (File List):** 2-3 hours
- **Feature 4 (Move Command):** 1 hour
- **Feature 5 (System Tray):** 1-2 hours
- **Testing & Polish:** 2-3 hours

**Total:** ~10-15 hours of development

Split across:
- Day 1: Setup + File Watcher
- Day 2: Settings + File List
- Day 3: Move logic + System Tray + Testing

## 🚀 After v0.1

Once v0.1 works (manual classification):

**v0.2:** Add LLM classification
- Port `python-prototype/agent/llm_classifier.py` to Rust
- Use `reqwest` crate for OpenAI API
- Add confidence display in UI

**v0.3:** Add learning system
- Port SQLite database logic
- Implement feedback tracking
- Confidence adjustments

**v0.4:** Ollama integration
- Free tier with local LLM
- Fallback architecture

**v1.0:** Polish & Release
- Auto-updater
- Installer
- Documentation
- Marketing site

## 📚 Learning Resources

While building:
- **Rust basics:** https://doc.rust-lang.org/book/
- **Tauri guides:** https://tauri.app/v1/guides/
- **React docs:** https://react.dev/
- **Rust-React communication:** https://tauri.app/v1/guides/features/command

## ✅ Definition of Done (v0.1)

v0.1 is complete when:
- [ ] App starts without errors
- [ ] User can select watch folder
- [ ] File detection works reliably
- [ ] Files appear in UI when detected
- [ ] User can choose destination folder
- [ ] "Move" button successfully moves file
- [ ] System tray icon shows
- [ ] App runs in background
- [ ] No crashes or errors
- [ ] Code is committed to git

---

**Current Status:** Repository reorganized, ready for Tauri setup.
**Next Action:** Install Rust (see TAURI_SETUP.md)
