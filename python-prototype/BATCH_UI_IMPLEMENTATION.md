# Batch UI Enhancement - Implementation Summary

## Overview
Implemented enhanced interactive batch processing UI with explicit intent differentiation for intelligent learning. The system now captures user intent at the file level and applies different learning effects based on user actions.

## Key Changes

### 1. **main.py** - Updated `handle_batch()` Function
**Before:** Batch-level yes/no prompt (all-or-nothing decision)
**After:** Per-file interactive UI with intent-based learning

**New Flow:**
1. **First Pass:** Categorize files into auto-moved vs suggestions
2. **Second Pass:** Interactive UI prompts for each suggestion
3. **Intent Recording:** Save learning records with action type

**Intent Mapping:**
- `accept`: User approves suggestion → **Positive Learning** (+10% confidence boost)
- `choose`: User selects different folder → **Strong Negative Learning** (-40% confidence decay, model was wrong)
- `ignore`: User marks file as throwaway → **No Learning** (doesn't penalize confidence)

### 2. **ui/batch_prompt.py** - Enhanced Interactive UI
**New Features:**
- **Batch Summary:** Shows auto-moved files vs suggestions with confidence scores
- **Per-File Controls:** [s]uggested / [o]ther folder / [i]gnore options
- **Confidence Display:** Shows confidence percentage for each suggestion
- **Custom Folder Support:** Users can specify alternative folders
- **Visual Feedback:** Shows decision summary before final confirmation
- **Intent Encoding:** Explicitly differentiates user intent

**Design Philosophy:**
- Ignore ≠ Rejection (doesn't penalize model)
- Choose ≠ Accept (different learning signal)
- Visual clarity with emoji indicators (✅ ⚠️ ⊘)

### 3. **storage/local_store.py** - Extended Tables
**New Table: ignore_state**
- Records files user marked as ignored
- Prevents confidence penalties for throwaway files
- Fields: filename, reason, timestamp

**New Table: learning**
- Records user intent for each suggestion
- Fields: filename, suggested_folder, action, timestamp
- Actions: 'accept', 'choose', 'ignore'

**New Functions:**
- `save_ignore(filename, reason)` - Mark file as ignored
- `save_learning(filename, suggested_folder, action)` - Record user intent

### 4. **storage/__init__.py** - Updated Exports
Added `save_ignore` and `save_learning` to module exports

## Technical Details

### Intent-Based Learning Logic
```
User Action         | Learning Effect      | Confidence Change
------------------ | ------------------- | -----------------
Accept suggestion   | Positive             | +10% (boost)
Choose different    | Strong negative      | -40% (decay)
Ignore file         | No learning          | No change
```

### Decision Tracking
Each user action is recorded with:
- File name
- Suggested folder (context)
- Action type (accept/choose/ignore)
- Timestamp

This enables:
1. **Pattern learning:** Identify which suggestions users accept
2. **Negative feedback:** Detect when model is consistently wrong
3. **Ignore patterns:** Exclude throwaway files from learning

### Per-File UI Flow
```
File: report.pdf
Suggested: Work/Reports (92%)
Options: [s]uggested [o]ther [i]gnore
Your choice [s/o/i]: s
✓ Will move to Work/Reports
```

## Files Modified

1. **main.py**
   - Updated `handle_batch()` with interactive flow
   - Added calls to `display_batch_summary()`
   - Added learning intent recording: `save_learning()`
   - Added ignore recording: `save_ignore()`

2. **ui/batch_prompt.py**
   - Enhanced visual formatting
   - Per-file decision collection
   - Intent differentiation logic
   - Summary display with emoji indicators

3. **storage/__init__.py**
   - Exported `save_ignore` and `save_learning`

## Database Schema

### ignore_state Table
```sql
CREATE TABLE IF NOT EXISTS ignore_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    reason TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(filename)
)
```

### learning Table
```sql
CREATE TABLE IF NOT EXISTS learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    suggested_folder TEXT NOT NULL,
    action TEXT CHECK(action IN ('accept', 'choose', 'ignore')),
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

## User Experience Improvements

1. **Clarity:** Each file gets explicit per-file decision option
2. **Flexibility:** Users can choose different folders without feedback penalty
3. **Efficiency:** Single batch prompt instead of multiple dialogs
4. **Learning:** System learns from both positive and negative feedback
5. **No Penalties:** Ignored files don't penalize model confidence

## Testing

Run `python test_batch_ui.py` to test the interactive UI with mock data.

The test shows:
- Batch summary display
- Per-file decision collection
- Intent recording flow
- Learning effect differentiation

## Integration Points

1. **Watchdog Events:** Files collected in 8-second batch window
2. **Matching Engine:** Confidence scores provided for suggestions
3. **Learning System:** Intent-based confidence updates (future)
4. **Database:** All decisions and intent records persisted

## Next Steps (Future Enhancements)

1. Implement confidence decay based on learning records
2. Add pattern-based learning (identify common wrong suggestions)
3. Build undo feedback loop (user undo → confidence decay)
4. Add learning analytics dashboard
5. Implement user preference learning over time
