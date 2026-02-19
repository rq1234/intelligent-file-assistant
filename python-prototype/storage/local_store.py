import os
import sqlite3
import yaml
from datetime import datetime
from config.settings import MAX_UNDO_HISTORY

DB_PATH = "storage/state.db"
SCOPES_PATH = "config/scopes.yaml"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS decisions (
            filename TEXT,
            folder TEXT
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS undo_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            filename TEXT,
            src TEXT,
            dst TEXT
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS ignore_state (
            filename TEXT PRIMARY KEY,
            reason TEXT
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS learning (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT,
            suggested_folder TEXT,
            action TEXT,
            timestamp TEXT
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS ignore_patterns (
            pattern TEXT PRIMARY KEY,
            reason TEXT,
            created_at TEXT
        )
    """)
    conn.commit()
    conn.close()

def save_decision(filename, folder):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO decisions VALUES (?, ?)", (filename, folder))
    conn.commit()
    conn.close()


def save_undo_history(src, dst):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "INSERT INTO undo_history (timestamp, filename, src, dst) VALUES (?, ?, ?, ?)",
        (datetime.now().isoformat(), os.path.basename(src), src, dst)
    )

    # Keep only the most recent MAX_UNDO_HISTORY entries
    c.execute(
        """
        DELETE FROM undo_history
        WHERE id NOT IN (
            SELECT id FROM undo_history ORDER BY id DESC LIMIT ?
        )
        """,
        (MAX_UNDO_HISTORY,)
    )

    conn.commit()
    conn.close()


def get_undo_history(limit=10):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "SELECT timestamp, filename, src, dst FROM undo_history ORDER BY id DESC LIMIT ?",
        (limit,)
    )
    rows = c.fetchall()
    conn.close()

    return [
        {
            "timestamp": row[0],
            "file": row[1],
            "from": row[2],
            "to": row[3],
        }
        for row in rows
    ]


def save_ignore(filename, reason="user_ignored"):
    """Mark a file as ignored by user"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "INSERT OR REPLACE INTO ignore_state (filename, reason) VALUES (?, ?)",
        (filename, reason)
    )
    conn.commit()
    conn.close()


def save_learning(filename, suggested_folder, action):
    """
    Record user action for learning
    
    Args:
        filename: File that was processed
        suggested_folder: Folder we suggested
        action: 'accept', 'choose', 'ignore' (user intent)
    """
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "INSERT INTO learning (filename, suggested_folder, action, timestamp) VALUES (?, ?, ?, ?)",
        (filename, suggested_folder, action, datetime.now().isoformat())
    )
    conn.commit()
    conn.close()


def is_file_ignored(filename):
    """Check if a file is explicitly ignored by user"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT reason FROM ignore_state WHERE filename = ?", (filename,))
    result = c.fetchone()
    conn.close()
    return result is not None


def save_ignore_pattern(pattern, reason="user_preference"):
    """
    Save a pattern to ignore files matching it in the future
    
    Args:
        pattern: File pattern (e.g., '*.tmp', '~*', 'Thumbs.db')
        reason: Why this pattern should be ignored
    """
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "INSERT OR REPLACE INTO ignore_patterns (pattern, reason, created_at) VALUES (?, ?, ?)",
        (pattern, reason, datetime.now().isoformat())
    )
    conn.commit()
    conn.close()


def get_ignore_patterns():
    """Get all ignore patterns"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT pattern FROM ignore_patterns")
    patterns = [row[0] for row in c.fetchall()]
    conn.close()
    return patterns


def matches_ignore_pattern(filename):
    """
    Check if filename matches any ignore pattern using fnmatch
    
    Args:
        filename: File to check (just the basename)
        
    Returns:
        bool: True if filename matches any ignore pattern
    """
    import fnmatch
    
    patterns = get_ignore_patterns()
    return any(fnmatch.fnmatch(filename, pattern) for pattern in patterns)



def load_scopes(scopes_path=SCOPES_PATH):
    if not os.path.exists(scopes_path):
        return []

    with open(scopes_path, "r", encoding="utf-8") as file:
        data = yaml.safe_load(file) or {}

    scopes = data.get("scopes", [])
    for scope in scopes:
        if "root" in scope:
            scope["root"] = os.path.expanduser(scope["root"])

    return scopes
