# Intelligent File Assistant

An AI-powered file organization tool that automatically classifies and moves files using LLM-based semantic understanding.

##  Project Status

This repository contains two versions:

###  **Tauri Native App** (In Development)
- **Location:** `tauri-app/`
- **Status:** v0.1 MVP in progress
- **Tech Stack:** Rust + React + Tauri
- **Goal:** Cross-platform native desktop app

###  **Python CLI Prototype** (Functional)
- **Location:** `python-prototype/`
- **Status:** Feature-complete prototype
- **Tech Stack:** Python + OpenAI API
- **Purpose:** Reference implementation

##  Repository Structure

```
intelligent-file-assistant/
├── tauri-app/              # Native desktop app (Rust + React)
│   ├── src-tauri/          # Rust backend
│   └── src/                # React frontend
│
├── python-prototype/       # Python CLI version
│   ├── agent/              # Classification logic
│   ├── watcher/            # File monitoring
│   └── main.py             # Entry point
│
└── README.md               # This file
```

##  Quick Start

### Tauri App (Recommended for end users)
```bash
cd tauri-app
npm install
npm run tauri dev
```

### Python Prototype (For development/testing)
```bash
cd python-prototype
pip install -r requirements.txt
cp .env.example .env
# Add your OPENAI_API_KEY to .env
python main.py
```

##  Documentation

- **Tauri App:** See `tauri-app/README.md`
- **Python Prototype:** See `python-prototype/README.md`





---

**Current Focus:** Building v0.1 of Tauri native app with file watching and manual classification.
