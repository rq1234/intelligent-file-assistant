"""
Local storage implementation using SQLite
"""
import sqlite3
import json
from pathlib import Path
from datetime import datetime, timedelta


class LocalStore:
    """Local storage for actions, learning records, and state"""
    
    def __init__(self, db_path=None):
        """
        Initialize the local store
        
        Args:
            db_path: Path to the SQLite database file
        """
        if db_path is None:
            db_path = Path(__file__).parent / 'state.db'
        
        self.db_path = db_path
        self._init_database()
    
    def _init_database(self):
        """Initialize the database schema"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Actions table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS actions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                source TEXT NOT NULL,
                target TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                undone INTEGER DEFAULT 0
            )
        ''')
        
        # Learning records table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS learning_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                decision TEXT NOT NULL,
                outcome TEXT NOT NULL,
                timestamp TEXT NOT NULL
            )
        ''')
        
        # Corrections table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS corrections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                suggested_path TEXT NOT NULL,
                actual_path TEXT NOT NULL,
                timestamp TEXT NOT NULL
            )
        ''')
        
        conn.commit()
        conn.close()
    
    def record_action(self, action):
        """Record a file action"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            INSERT INTO actions (type, source, target, timestamp)
            VALUES (?, ?, ?, ?)
        ''', (action['type'], action['source'], action['target'], action['timestamp']))
        
        conn.commit()
        conn.close()
    
    def get_last_action(self):
        """Get the last action that hasn't been undone"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT type, source, target, timestamp, id
            FROM actions
            WHERE undone = 0
            ORDER BY id DESC
            LIMIT 1
        ''')
        
        row = cursor.fetchone()
        conn.close()
        
        if row:
            return {
                'type': row[0],
                'source': row[1],
                'target': row[2],
                'timestamp': row[3],
                'id': row[4]
            }
        return None
    
    def mark_action_undone(self, action):
        """Mark an action as undone"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            UPDATE actions
            SET undone = 1
            WHERE id = ?
        ''', (action['id'],))
        
        conn.commit()
        conn.close()
    
    def get_action_history(self, limit=10):
        """Get the history of actions"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT type, source, target, timestamp, undone
            FROM actions
            ORDER BY id DESC
            LIMIT ?
        ''', (limit,))
        
        rows = cursor.fetchall()
        conn.close()
        
        return [
            {
                'type': row[0],
                'source': row[1],
                'target': row[2],
                'timestamp': row[3],
                'undone': bool(row[4])
            }
            for row in rows
        ]
    
    def save_learning_record(self, record):
        """Save a learning record"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            INSERT INTO learning_records (file_path, decision, outcome, timestamp)
            VALUES (?, ?, ?, ?)
        ''', (record['file_path'], json.dumps(record['decision']), 
              record['outcome'], record['timestamp']))
        
        conn.commit()
        conn.close()
    
    def save_correction(self, correction):
        """Save a user correction"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            INSERT INTO corrections (file_path, suggested_path, actual_path, timestamp)
            VALUES (?, ?, ?, ?)
        ''', (correction['file_path'], correction['suggested_path'],
              correction['actual_path'], correction['timestamp']))
        
        conn.commit()
        conn.close()
    
    def cleanup_old_records(self, days=30):
        """Clean up old records"""
        cutoff_date = (datetime.now() - timedelta(days=days)).isoformat()
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('DELETE FROM actions WHERE timestamp < ?', (cutoff_date,))
        cursor.execute('DELETE FROM learning_records WHERE timestamp < ?', (cutoff_date,))
        cursor.execute('DELETE FROM corrections WHERE timestamp < ?', (cutoff_date,))
        
        conn.commit()
        conn.close()
