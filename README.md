# File Organiser AI

An intelligent file organization system that automatically categorizes and moves files based on their content and context, with **learning capabilities** that improve over time.

## Key Features

### 🎯 Smart File Matching
- **Content-aware**: Extracts text from PDFs, DOCX, images (OCR)
- **Token overlap**: Matches filename patterns to folder names
- **Fuzzy matching**: Handles typos and variations
- **File-type weighting**: Prioritizes high-value files (PDFs, docs) over images

### 🧠 Adaptive Learning System
- **Intent differentiation**: Understands the difference between:
  - ✓ **Accept** - You agree with suggestion → Boosts confidence (+10%)
  - ⚠ **Choose different** - Suggestion was wrong → Penalizes confidence (-40%)
  - ⊘ **Ignore** - File is throwaway → No learning effect (neutral)
- **Confidence adjustment**: Learns from your feedback to improve future predictions
- **Folder reputation**: Tracks which folders have high/low acceptance rates

### 📦 Batch Processing
- **Debounce phase** (2 seconds): Waits for files to finish downloading
- **Batch window** (8 seconds): Groups related files together
- **Smart routing**: Single file vs batch handling
- **Interactive UI**: Review and approve/modify suggestions in one go

### ↩️ Undo & Correction
- **Undo history**: Revert any file move (up to 10 recent moves)
- **Learning feedback**: Undoing a move teaches the system it was wrong
- **Interactive CLI**: Choose which moves to undo

### 📊 Analytics Dashboard
- **Acceptance rate**: See which folders perform well
- **Problem detection**: Identify folders with high rejection rates
- **Recent feedback**: Track your decision history
- **Model accuracy**: Overall system performance metrics

### 🔒 Safety Features
- **Duplicate detection**: Checks filename, hash, and content
- **Ignore patterns**: Skip temporary files, system files, etc.
- **Locked file handling**: Automatic retry with exponential backoff
- **Confidence thresholds**: Only auto-move high-confidence matches (≥85%)

## Installation

```bash
pip install -r requirements.txt
```

### Dependencies
- `watchdog` - File system monitoring
- `PyPDF2` - PDF text extraction
- `python-docx` - DOCX text extraction
- `python-pptx` - PowerPoint text extraction
- `pytesseract` - OCR for images
- `Pillow` - Image processing
- `rapidfuzz` - Fuzzy string matching
- `pyyaml` - Configuration file parsing

## Quick Start

### 1. Configure Scopes
Edit `config/scopes.yaml` to define your folder structure:

```yaml
scopes:
  - root: ~/Documents/Work
  - root: ~/Documents/Personal
  - root: ~/Documents/School
```

### 2. Start Watching
```bash
python main.py
```

The system will watch your Downloads folder and organize new files automatically.

### 3. Review Decisions
When files arrive, you'll see:
- **Auto-moved**: High confidence files (≥85%) moved immediately
- **Suggestions**: Medium confidence (40-85%) - you decide
- **Skipped**: Low confidence (<40%) - ignored

### 4. Provide Feedback
For suggestions, you can:
- `[s]` Accept suggestion → File moved, confidence boosted
- `[o]` Choose different folder → File moved, suggestion penalized
- `[i]` Ignore file → No move, no learning effect

## Advanced Usage

### Undo Mistakes
```bash
# Interactive mode - shows history and lets you pick
python undo_cli.py

# Undo last move immediately
python undo_cli.py --last

# View history only
python undo_cli.py --history
```

### View Analytics
```bash
# Full dashboard
python stats_cli.py

# Quick summary
python stats_cli.py --summary
```

### Ignore Patterns
When you ignore a file, the system asks if you want to ignore similar files:
```
❓ Should we ignore files like 'temp_upload.tmp' in the future?
  [1] *.tmp
  [2] temp*
  [0] No thanks
```

This creates reusable ignore patterns that skip matching files automatically.

## Configuration

### Settings (`config/settings.yaml`)

```yaml
# Confidence thresholds
auto_move_threshold: 0.85    # Auto-move if ≥85% confident
suggest_threshold: 0.40       # Show suggestion if ≥40% confident

# Batch processing
batch_window_seconds: 8       # Wait 8 seconds to group files

# Undo history
max_undo_history: 10          # Keep last 10 moves
```

### Scopes (`config/scopes.yaml`)

Define which folders to search for matches:

```yaml
scopes:
  - root: ~/Documents/Work
  - root: ~/Documents/Personal
```

The system will scan subdirectories within these roots to find the best match.

## How Learning Works

### Confidence Formula

**Base Confidence** = weighted combination of:
- 40% token overlap (filename ↔ folder name)
- 30% fuzzy matching
- 30% content similarity (extracted text)
- File type weight (PDFs = 1.0, images = 0.2)

**Learning Adjustment** = based on past feedback:
- Each **accept**: +10% (max +50%)
- Each **reject**: -40% (max -50%)
- **Ignores** have no effect

**Folder Reputation** = gentle boost/penalty (±5%) if folder has:
- High acceptance rate historically → small boost
- High rejection rate historically → small penalty

### Learning Timeline

1. **First encounter**: Base confidence only (no history)
2. **After feedback**: Confidence adjusted based on your choices
3. **Multiple samples**: Folder reputation kicks in (needs ≥5 samples)
4. **Long term**: System learns your preferences and improves

## Database Schema

All data is stored in `storage/state.db`:

- **decisions**: Filename → folder mappings (memory)
- **learning**: User feedback (accept/choose/ignore)
- **undo_history**: Recent moves for undo functionality
- **ignore_state**: Files explicitly ignored
- **ignore_patterns**: Pattern-based ignore rules

## Architecture

```
file-organiser-ai/
├── main.py                  # Entry point, orchestration
├── agent/
│   ├── matcher.py          # File → folder matching logic
│   ├── decision.py         # Confidence → action decision
│   ├── confidence.py       # Confidence score computation
│   ├── learning_logic.py   # Learning adjustments (NEW!)
│   ├── batch.py            # Batch window management
│   └── retry_queue.py      # Locked file handling
├── actions/
│   ├── mover.py            # File moving + safety checks
│   └── undo.py             # Undo functionality (UPDATED!)
├── watcher/
│   └── download_watcher.py # File system monitoring
├── storage/
│   └── local_store.py      # SQLite database interface
├── ui/
│   └── batch_prompt.py     # Interactive batch UI
├── features/
│   └── content_extractors.py  # PDF/DOCX/OCR extraction
├── config/
│   ├── settings.yaml       # Configuration
│   └── scopes.yaml         # Folder structure
├── undo_cli.py             # Undo command-line tool (NEW!)
└── stats_cli.py            # Analytics dashboard (NEW!)
```

## Testing

Run the test suite to verify everything works:

```bash
python test_improvements.py
```

This tests:
- Learning logic integration
- Confidence adjustments
- Analytics insights
- Database schema

## Troubleshooting

### Files not being detected
- Check that the Downloads path is correct for your system
- On OneDrive: The watcher includes a periodic scan fallback
- Check if files match ignore patterns

### Confidence always low
- System needs learning data - provide more feedback
- Check if scopes.yaml includes relevant folders
- Verify file content can be extracted (PDFs readable, etc.)

### Undo not working
- File must still exist at destination
- Original location must be available
- Check undo history: `python undo_cli.py --history`

## Design Philosophy

### Why "Ignore" ≠ "Reject"

The system differentiates user intent:

- **Reject** (choose different) = "This suggestion is WRONG" → Penalize model
- **Ignore** = "This file is throwaway/temp" → No penalty

This prevents penalizing the model for suggesting folders for files that don't belong anywhere (temporary downloads, test files, etc.).

### Why Not Pure ML?

This is **evidence aggregation**, not machine learning:
- Transparent scoring (you can see why it chose a folder)
- No training data needed upfront
- Learns from real usage incrementally
- Explainable decisions

## Contributing

This is a personal project, but suggestions and improvements are welcome!

## License

MIT License - See LICENSE file for details
