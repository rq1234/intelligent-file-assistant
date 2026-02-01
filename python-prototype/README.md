# Intelligent File Assistant

An AI-powered file organization system that uses **LLM-based semantic understanding** to automatically categorize and move files, with **learning capabilities** that improve over time.

## 🎯 Key Features

### 🤖 LLM-Based Classification (NEW!)
- **Semantic understanding**: Uses OpenAI GPT models to understand file context
- **90%+ accuracy**: Correctly matches "IntegerProgrammingTricks.pdf" → "Operations Research"
- **Content-aware**: Analyzes extracted text from PDFs, DOCX, PPTX, images (OCR)
- **Intelligent fallback**: Falls back to string-based matching if LLM fails
- **Cost-effective**: Uses gpt-4o-mini (~$0.15/month for typical usage)

### 🎯 Smart File Matching
- **LLM primary**: Semantic classification with reasoning
- **String fallback**: Token overlap, fuzzy matching, content similarity
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

### Prerequisites
- Python 3.8+
- OpenAI API key ([Get one here](https://platform.openai.com/api-keys))

### Setup

1. **Clone the repository**:
```bash
git clone https://github.com/rq1234/intelligent-file-assistant.git
cd intelligent-file-assistant
```

2. **Install dependencies**:
```bash
pip install -r requirements.txt
```

3. **Configure API key**:
```bash
# Copy the example env file
cp .env.example .env

# Edit .env and add your OpenAI API key
# OPENAI_API_KEY=sk-proj-...your-key-here...
```

4. **Configure folders**:
```bash
# Edit config/scopes.yaml to set your target folders
nano config/scopes.yaml
```

### Dependencies
- `watchdog` - File system monitoring
- `openai` - OpenAI API client for LLM classification
- `python-dotenv` - Environment variable management
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

## How It Works

### Classification Pipeline

1. **Memory Check**: Has this exact filename been classified before? → Use previous decision
2. **LLM Classification** (Primary):
   - Extract file content (PDF/DOCX text, OCR from images)
   - Send to OpenAI: filename + content + available folders
   - Get semantic match with reasoning (e.g., "Integer Programming is a topic in Operations Research")
   - Confidence: 60-95% based on LLM certainty
3. **String-Based Fallback** (if LLM fails):
   - Token overlap: filename ↔ folder name matching
   - Fuzzy matching: handles typos
   - Content similarity: extracted text matching
   - File type weighting: PDFs=1.0, images=0.2
4. **Learning Adjustment**: Apply confidence boost/penalty from past feedback
5. **Action Decision**: Auto-move (>85%), suggest (60-85%), or skip (<60%)

### LLM Classification

**Example:**
```
File: "IntegerProgrammingTricks.pdf"
Folders: [Corporate Finance, Econometrics, Machine Learning, Operations Research]

LLM Response:
{
  "folder": "Operations Research",
  "confidence": 90,
  "reasoning": "Integer Programming is a fundamental optimization technique in Operations Research"
}
```

**Advantages:**
- Understands semantic relationships (Integer Programming ⊂ Operations Research)
- Handles abbreviations, synonyms, topic hierarchies
- Analyzes file content, not just filename
- 90%+ accuracy vs 60-70% for string-based

### How Learning Works

**Base Confidence** = from LLM (60-95%) or string-based matching (0-100%)

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
intelligent-file-assistant/
├── main.py                  # Entry point, orchestration
├── agent/
│   ├── llm_classifier.py   # OpenAI LLM integration (NEW!)
│   ├── matcher.py          # File → folder matching logic
│   ├── decision.py         # Confidence → action decision
│   ├── confidence.py       # Confidence score computation
│   ├── learning_logic.py   # Learning adjustments
│   ├── batch.py            # Batch window management
│   └── retry_queue.py      # Locked file handling
├── actions/
│   ├── mover.py            # File moving + safety checks
│   └── undo.py             # Undo functionality
├── watcher/
│   └── download_watcher.py # File system monitoring + synchronous blocking
├── storage/
│   └── local_store.py      # SQLite database interface
├── ui/
│   └── batch_prompt.py     # Interactive batch UI
├── utils/
│   └── user_input.py       # Coordinated input handling (NEW!)
├── features/
│   └── content_extractors.py  # PDF/DOCX/OCR extraction
├── telemetry/
│   └── events.py           # Analytics/telemetry tracking
├── config/
│   ├── settings.yaml       # Configuration
│   └── scopes.yaml         # Folder structure
├── .env                    # API keys (not committed)
├── .env.example            # Environment template
├── undo_cli.py             # Undo command-line tool
├── stats_cli.py            # Analytics dashboard
└── test_llm_classifier.py  # LLM classification test
```

## API Costs

Using `gpt-4o-mini` (recommended):
- **Per file**: ~$0.00025 (about 1/40th of a cent)
- **Typical usage**: 20 files/day × 30 days = ~$0.15/month
- **Fallback**: Free string-based matching if API fails or is disabled

**Cost optimization:**
- Memory: Files seen before use cached decision (free)
- Batch processing: Single LLM call can classify multiple files
- Configurable: Set `ai.enabled: false` to use only string-matching

**Future:** Free tier planned using local LLM (Ollama) for $0/month

## Security

✅ **API keys protected:**
- Stored in `.env` file (never committed to git)
- `.gitignore` excludes all sensitive files
- GitHub push protection blocks accidental key exposure
- Environment variable priority: `OPENAI_API_KEY` env var → `settings.yaml`

✅ **Best practices:**
```bash
# NEVER commit .env
# NEVER hardcode API keys
# ALWAYS use environment variables
```

## Testing

Run the test suite to verify everything works:

```bash
# Test LLM classification
python test_llm_classifier.py

# Test learning system
python test_improvements.py

# Test batch UI
python test_batch_ui.py
```

This tests:
- LLM integration and semantic matching
- Learning logic and confidence adjustments
- Analytics insights
- Database schema
- Batch processing UI

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
