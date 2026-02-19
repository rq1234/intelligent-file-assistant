"""
Storage module for state persistence
"""
from .local_store import (
    init_db, save_decision, load_scopes, save_undo_history, get_undo_history,
    save_ignore, save_learning, is_file_ignored, save_ignore_pattern,
    get_ignore_patterns, matches_ignore_pattern
)

__all__ = [
    'init_db', 'save_decision', 'load_scopes', 'save_undo_history', 'get_undo_history',
    'save_ignore', 'save_learning', 'is_file_ignored', 'save_ignore_pattern',
    'get_ignore_patterns', 'matches_ignore_pattern'
]
