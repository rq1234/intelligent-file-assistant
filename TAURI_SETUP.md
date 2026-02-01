# Tauri App Setup Guide

This guide explains how to set up the development environment for the Tauri native app.

## ✅ Prerequisites Check

You have:
- ✅ Node.js (v22.16.0)
- ✅ npm (10.9.2)
- ❌ Rust (not installed)

## 🦀 Step 1: Install Rust

### Windows (Your System)

Open PowerShell and run:
```powershell
# Download and run Rust installer
Invoke-WebRequest -Uri https://win.rustup.rs -OutFile rustup-init.exe
.\rustup-init.exe
```

Follow the prompts (just press Enter for defaults).

**After installation:**
```powershell
# Restart your terminal, then verify:
rustc --version
cargo --version
```

You should see something like:
```
rustc 1.75.0 (hash)
cargo 1.75.0 (hash)
```

### Alternative: Using winget (Windows 11+)
```powershell
winget install Rustlang.Rustup
```

## 🔧 Step 2: Install Tauri Prerequisites (Windows)

### Install Microsoft C++ Build Tools

Tauri requires C++ compiler on Windows:

```powershell
# Using winget:
winget install Microsoft.VisualStudio.2022.BuildTools

# Or download manually:
# https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022
```

During installation, select:
- ✅ "Desktop development with C++"
- ✅ "MSVC v143 - VS 2022 C++ x64/x86 build tools"
- ✅ "Windows 10/11 SDK"

### Install WebView2 Runtime

Windows 10/11 usually has this, but verify:

```powershell
# Check if installed:
Get-AppxPackage -Name Microsoft.WebView2

# If not installed, download:
# https://developer.microsoft.com/en-us/microsoft-edge/webview2/
```

## 🚀 Step 3: Create Tauri App

Once Rust is installed:

```bash
# Install create-tauri-app
npm create tauri-app@latest

# When prompted:
# - Project name: tauri-app
# - Choose: "TypeScript / JavaScript"
# - Pick UI template: "React" (with TypeScript)
# - Package manager: npm
```

This creates:
```
tauri-app/
├── src-tauri/          # Rust backend
│   ├── src/
│   │   └── main.rs     # Entry point
│   ├── Cargo.toml      # Rust dependencies
│   └── tauri.conf.json # App configuration
├── src/                # React frontend
│   ├── App.tsx
│   └── main.tsx
└── package.json
```

## 🏃 Step 4: Run Development Server

```bash
cd tauri-app
npm install           # Install JS dependencies
npm run tauri dev     # Start dev server
```

This will:
1. Compile Rust backend
2. Start React dev server
3. Open the app window
4. Enable hot-reload (code changes appear instantly)

**First run takes 5-10 minutes** (Rust compiles many dependencies).
Subsequent runs are fast (~10 seconds).

## 📚 Architecture Overview

### How Tauri Works

```
┌─────────────────────────────────────────┐
│       Tauri Desktop Application        │
├─────────────────────────────────────────┤
│                                         │
│  Frontend (React)      Backend (Rust)  │
│  ┌──────────────┐      ┌────────────┐  │
│  │ App.tsx      │◄────►│ main.rs    │  │
│  │              │ IPC  │            │  │
│  │ - UI         │      │ - Watcher  │  │
│  │ - Settings   │      │ - File ops │  │
│  │ - Dialogs    │      │ - Database │  │
│  └──────────────┘      └────────────┘  │
│       │                      │          │
│       └──────────────────────┘          │
│         invoke('command')               │
└─────────────────────────────────────────┘
```

### Communication (IPC)

**Frontend calls Backend:**
```typescript
// In React component:
import { invoke } from '@tauri-apps/api'

// Call Rust function
const result = await invoke('move_file', {
  sourcePath: '/path/to/file.pdf',
  destFolder: '/path/to/folder'
})
```

**Backend exposes commands:**
```rust
// In Rust (src-tauri/src/main.rs):
#[tauri::command]
fn move_file(source_path: String, dest_folder: String) -> Result<String, String> {
    // Actual file moving logic here
    fs::rename(&source_path, &dest_folder)?;
    Ok("File moved successfully".to_string())
}

// Register command
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![move_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Backend emits events:**
```rust
// Rust sends event to frontend
app.emit_all("file-detected", FileInfo {
    path: "/Downloads/report.pdf",
    size: 1024,
})?;
```

```typescript
// React listens for events
import { listen } from '@tauri-apps/api/event'

listen('file-detected', (event) => {
    console.log('New file:', event.payload)
    // Update UI
})
```

## 🎯 v0.1 Features We'll Build

1. **File Watcher (Rust)**
   - Monitor Downloads folder
   - Detect new files
   - Emit event to frontend

2. **Settings UI (React)**
   - Choose watched folder
   - Select target folders
   - Start/stop watching

3. **Manual Classification (React)**
   - Show detected file
   - Dropdown to choose destination
   - Button to move file

4. **System Tray (Rust)**
   - Background running
   - Quick access menu
   - Notifications

## 📦 What Gets Built

### Development Build
```bash
npm run tauri dev
```
- Fast compilation
- Hot reload enabled
- Debug logging
- Opens dev tools

### Production Build
```bash
npm run tauri build
```
- Optimized binary
- ~3-5MB size (Tauri magic!)
- Installer created:
  - Windows: `.msi` installer
  - Mac: `.dmg` disk image
  - Linux: `.deb` or `.AppImage`

## 🔍 Troubleshooting

### "rustc: command not found"
- Rust not installed or not in PATH
- Restart terminal after installing Rust
- Run: `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine")` (PowerShell)

### "linker 'link.exe' not found"
- C++ Build Tools not installed
- Install Visual Studio Build Tools (see Step 2)

### "WebView2 not found"
- Install WebView2 Runtime (see Step 2)
- Windows 11 has it by default

### "error[E0463]: can't find crate"
- Rust toolchain corrupted
- Run: `rustup update`

## 📚 Learning Resources

- **Tauri Docs:** https://tauri.app/v1/guides/
- **Rust Book:** https://doc.rust-lang.org/book/
- **React Docs:** https://react.dev/

## Next Steps

After setup completes:
1. Verify `npm run tauri dev` works
2. See default Tauri app window
3. Edit `src/App.tsx` and see hot reload
4. Edit `src-tauri/src/main.rs` and rebuild
5. Start building v0.1 features!

---

**Ready to proceed?** Run the Rust installer and we'll create the app together!
