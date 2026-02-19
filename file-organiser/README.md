# File Organizer AI

![CI](https://github.com/rq1234/intelligent-file-assistant/actions/workflows/ci.yml/badge.svg)

AI-powered desktop app that automatically organizes your coursework files into module folders using OpenAI classification.

## Features

- **File watcher** — monitors a folder for new files in real time
- **AI classification** — two-pass system (filename first, then content extraction for low-confidence results) using GPT-3.5-turbo / GPT-4o
- **OCR support** — extracts text from images via Tesseract for classification
- **PDF text extraction** — reads PDF content for smarter classification
- **Smart caching** — remembers previous classifications to skip redundant API calls
- **User-defined rules** — glob patterns to auto-route files without AI
- **Correction learning** — tracks when you override AI suggestions and improves over time
- **Auto-move** — optionally moves high-confidence files without confirmation
- **Batch actions** — accept all high-confidence suggestions at once
- **Activity log** — full history with undo support (move files back)
- **Duplicate handling** — replace, keep both, or skip when a file already exists
- **Statistics dashboard** — AI accuracy, files organized, top folders
- **System notifications** — desktop alerts when files are classified
- **System tray with auto-start** — runs on startup, lives in the tray
- **Dark mode** — toggle between light and dark themes
- **Smart rename** — AI suggests cleaner filenames for uninformative names (e.g. `IMG_20250207.pdf` → `ML_Lecture5_Neural_Networks.pdf`)
- **Drag and drop** — drop files directly into the app to classify them

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust toolchain](https://rustup.rs/) (rustup)
- OpenAI API key
- [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) (optional, for image text extraction)

## Setup

1. Clone the repository and install dependencies:
   ```bash
   cd file-organiser
   npm install
   ```

2. Create a `.env` file in `file-organiser/src-tauri/` with your OpenAI API key:
   ```
   OPENAI_API_KEY=sk-...
   ```
   Alternatively, you can set the API key in the app's Settings screen after first launch.

3. Run the development server:
   ```bash
   npm run dev
   ```

## Build

```bash
npm run build
```

This produces a native installer in `src-tauri/target/release/bundle/`.

## Architecture

```
file-organiser/
├── src/                    # Frontend (vanilla JS + CSS)
│   ├── main.js             # App logic, file detection, classification UI
│   ├── onboarding.js       # First-run setup screen
│   ├── settings.js         # Settings screen
│   ├── errors.js           # Error classification utilities
│   ├── utils.js            # Pure utility functions
│   ├── constants.js        # App constants
│   ├── storage.js          # SQLite database wrappers
│   ├── styles.css          # All styles (light + dark theme)
│   └── main.test.js        # Unit tests (node --test)
├── src-tauri/              # Backend (Rust + Tauri 2)
│   ├── src/
│   │   ├── lib.rs          # Tauri commands (file ops, watcher, tray)
│   │   ├── classifier.rs   # OpenAI API integration
│   │   └── db.rs           # SQLite schema and queries
│   └── Cargo.toml
├── index.html
└── package.json
```

- **Frontend:** Vanilla JS (ES modules) + CSS, bundled by Vite
- **Backend:** Rust (Tauri 2)
- **Database:** SQLite (via rusqlite)
- **AI:** OpenAI GPT-3.5-turbo (filename pass) / GPT-4o (content pass)

## Technical Decisions

### Why Tauri over Electron?

Electron bundles an entire Chromium browser (~150 MB). Tauri uses the OS webview and a Rust backend, producing a ~5 MB installer. For a utility app that sits in the system tray all day, the memory and disk footprint difference matters. Rust also gives us safe concurrency for the file watcher and direct access to OS APIs (filesystem, notifications, autostart) without Node.js native modules.

### Two-pass classification

A single GPT-4o call per file is slow and expensive. Instead:

1. **Pass 1 (fast):** Send only the filename to GPT-3.5-turbo. Cost: ~0.01 cents, latency: ~500ms. This correctly classifies most well-named files like `ML_Lecture5_Neural_Networks.pdf`.
2. **Pass 2 (fallback):** If confidence is below the threshold, extract the file content (PDF text or OCR for images) and send it to GPT-4o. Cost: ~0.5 cents, latency: ~2-3s. This handles ambiguous filenames like `document(1).pdf`.

This reduces API costs by ~90% for typical usage while maintaining accuracy on hard cases.

### SQLite over localStorage

The app originally used `localStorage` for corrections, activity log, and rules. This hit limits quickly — `localStorage` caps at 5-10 MB, has no query capability, and is wiped if the user clears browser data. SQLite (via rusqlite in Rust) gives us proper schema migrations, indexed queries, and persistent storage in the app data directory. A migration layer imports legacy `localStorage` data on first run.

### Vanilla JS over React/Vue

The UI is a single-page app with ~6 screens. A framework would add build complexity, bundle size, and a learning curve for contributors — all for a relatively simple DOM. ES modules + Vite give us fast HMR in development and tree-shaking in production. The trade-off is more manual DOM manipulation, but the app is small enough that this stays manageable.

### Cross-platform path handling

Tauri's file dialog returns OS-native paths (backslashes on Windows, forward slashes on macOS/Linux). Rather than normalizing everything to one format, the app detects the separator from the base path and uses it consistently. This avoids path corruption when the OS expects a specific separator format.

### Atomic rename-and-move

When the AI suggests a better filename, the app renames the file in place first, then moves it to the destination folder. If the move fails (e.g. destination full, permission denied), the rename is rolled back automatically. This prevents a partial state where a file is renamed but stuck in the wrong folder.

### Correction learning without fine-tuning

When you override an AI suggestion, the correction is stored and injected into future prompts as few-shot examples. This gives the model context about your preferences without needing fine-tuning infrastructure. If you correct "Physics" → "Quantum Mechanics" three times, the model learns that pattern from the prompt history alone.

## Testing

```bash
cd file-organiser
node src/main.test.js
```

## License

MIT
