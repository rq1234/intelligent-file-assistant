# Ignore State Implementation - Complete Guide

## Overview
The ignore system differentiates between **feedback** and **preferences**:
- **Feedback** affects confidence learning (accept = positive, choose = strong negative)
- **Preferences** are file patterns to skip (ignore means: throwaway/temporary/irrelevant)

## Key Principle: Ignore is NOT Feedback

### What Ignore Means
When user chooses **[i]gnore**:
- ✅ Don't move the file
- ✅ Don't prompt again for this specific file
- ✅ Don't penalize model confidence
- ✅ Optionally ask about ignoring similar files

### What Ignore Does NOT Mean
- ❌ NOT a rejection of the suggestion (that's what "choose" is for)
- ❌ NOT feedback that reduces confidence
- ❌ NOT forcing user to choose a folder
- ❌ NOT penalizing the model for offering the suggestion

## Implementation

### 1. File-Level Ignore (Explicit)
When user marks a file as ignored:
```python
save_ignore(filename, "user_ignored_suggestion")
```
- Stored in `ignore_state` table
- Prevents re-processing this exact file
- Checked before matching: `is_file_ignored(filename)`

### 2. Pattern-Based Ignore (Preference)
After user ignores a file, system asks:
```
❓ Should we ignore files like 'temp_file.tmp' in the future?
  [1] *.tmp
  [2] temp*
  [0] No thanks
```

**System suggests patterns for:**
- File extension (e.g., `*.tmp`, `*.bak`)
- File prefix (e.g., `~*` for temp files, `.*` for hidden)
- Common keywords (e.g., `*tmp*`, `*temp*`)

When user confirms pattern:
```python
save_ignore_pattern(pattern, "inferred_from_filename")
```
- Stored in `ignore_patterns` table
- Checked on every batch: `matches_ignore_pattern(filename)`
- Uses `fnmatch` for shell-style pattern matching

### 3. Processing Flow

```
New file arrives
    ↓
Check: is_file_ignored(filename)?
    ├─ YES → Skip (already ignored)
    ↓
Check: matches_ignore_pattern(filename)?
    ├─ YES → Skip (matches pattern)
    ↓
Try to match to folder
    ├─ High confidence → Auto-move
    ├─ Medium confidence → Show suggestion
    └─ Low confidence → Skip
    ↓
User sees batch UI with suggestions
    ├─ [s]uggested → accept
    ├─ [o]ther folder → choose (with feedback)
    └─ [i]gnore → ignore (no feedback)
         ↓
         Ask "Ignore similar files?"
         ├─ User selects pattern
         └─ save_ignore_pattern()
```

## Database Schema

### ignore_state table
Explicit per-file ignores:
```sql
CREATE TABLE ignore_state (
    filename TEXT PRIMARY KEY,
    reason TEXT
);
```
- One entry per ignored file
- `reason` indicates why (e.g., "user_ignored_suggestion", "matches_ignore_pattern")

### ignore_patterns table
Patterns to skip in the future:
```sql
CREATE TABLE ignore_patterns (
    pattern TEXT PRIMARY KEY,
    reason TEXT,
    created_at TEXT
);
```
- One entry per pattern (e.g., "*.tmp", "~*", "*temp*")
- `reason` shows origin (e.g., "inferred_from_filename", "user_defined")
- Supports shell-style wildcards via `fnmatch`

## API Functions

### Storage (storage/local_store.py)
```python
# Check if file is ignored
is_file_ignored(filename: str) → bool

# Mark file as ignored
save_ignore(filename: str, reason: str = "user_ignored")

# Save pattern to ignore in future
save_ignore_pattern(pattern: str, reason: str = "user_preference")

# Get all patterns
get_ignore_patterns() → List[str]

# Check if filename matches any pattern
matches_ignore_pattern(filename: str) → bool
```

### Main (main.py)
```python
# Ask user about ignoring similar files
ask_ignore_pattern(filename: str)
```
- Called after user ignores a file
- Suggests patterns based on extension, prefix, keywords
- Gets user confirmation before saving pattern

## Usage Examples

### Example 1: Ignore Temporary Files
1. User ignores `temp_upload_123.tmp`
2. System asks: "Ignore files like this?"
3. Suggests: `[1] *.tmp  [2] temp*`
4. User chooses `[1]`
5. Future `.tmp` files automatically skipped

### Example 2: Ignore Hidden Files
1. User ignores `.DS_Store`
2. System asks: "Ignore files like this?"
3. Suggests: `[1] .*`
4. User chooses `[1]`
5. Future hidden files automatically skipped

### Example 3: Explicit Rejection vs Ignore
```
File: report.pdf
Suggested: Work/Reports (62%)

User chooses [o] and enters: Personal/Documents
→ save_learning(..., "choose")
→ Model learns suggestion was WRONG (negative feedback)
→ Confidence in "Work/Reports" decreases by 40%

versus

User chooses [i] gnore
→ save_ignore()
→ No learning recorded
→ Model confidence UNCHANGED
→ System asks about ignoring similar files
```

## Learning Implications

### What Affects Confidence
| Action    | Learning Effect | Confidence Change |
|-----------|-----------------|------------------|
| Accept    | Positive        | +10% (boost)      |
| Choose    | Strong negative | -40% (decay)      |
| Ignore    | NONE            | No change         |

### Why Ignore Doesn't Affect Confidence
- File might be throwaway (temp upload, test file)
- File might be irrelevant to any folder (random attachment)
- File might be from different context (colleague's file)
- Ignoring doesn't indicate the suggestion was WRONG

## Best Practices

1. **Don't treat ignore as rejection** - It's not feedback on the model
2. **Use ignore for throwaway files** - temp, test, cache, downloads artifacts
3. **Use choose for wrong suggestions** - Model suggested wrong folder
4. **Use accept for right suggestions** - Model got it correct
5. **Pattern-based ignoring is a preference** - Not a confidence modifier

## Config Settings
Settings are in `config/settings.yaml`:
```yaml
# Thresholds for decision making
auto_move_threshold: 0.85
suggest_threshold: 0.4
batch_window_seconds: 8
max_undo_history: 10
```

Ignore patterns are stored in database, not config (more flexible for user customization).
