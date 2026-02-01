# config/settings.py
"""
Load settings from YAML config
"""
import os
import yaml

# Load settings
SETTINGS_PATH = os.path.join(os.path.dirname(__file__), "settings.yaml")

with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
    _settings = yaml.safe_load(f)

# Export thresholds
AUTO_MOVE_TH = _settings.get("auto_move_threshold", 0.85)
SUGGEST_TH = _settings.get("suggest_threshold", 0.4)
BATCH_WINDOW_SECONDS = _settings.get("batch_window_seconds", 8)
MAX_UNDO_HISTORY = _settings.get("max_undo_history", 10)
