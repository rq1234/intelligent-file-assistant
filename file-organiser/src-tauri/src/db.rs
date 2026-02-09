//! Database module for SQLite persistence
//!
//! Handles corrections and activity log storage with automatic schema creation
//! and data limits enforcement.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use thiserror::Error;

// ============================================================
// ERROR TYPES
// ============================================================

#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", content = "message")]
pub enum DbError {
    #[error("Database initialization failed: {0}")]
    InitFailed(String),

    #[error("Database query failed: {0}")]
    QueryFailed(String),

    #[error("Database insert failed: {0}")]
    InsertFailed(String),

    #[error("Database update failed: {0}")]
    UpdateFailed(String),
}

impl From<rusqlite::Error> for DbError {
    fn from(err: rusqlite::Error) -> Self {
        DbError::QueryFailed(err.to_string())
    }
}

// ============================================================
// DATA TYPES
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: Option<i64>,
    pub pattern: String,
    pub target_folder: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Correction {
    pub id: Option<i64>,
    pub filename: String,
    pub ai_suggested: String,
    pub user_chose: String,
    pub correction_type: String,
    pub created_at: i64, // Unix timestamp ms
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityEntry {
    pub id: Option<i64>,
    pub filename: String,
    pub original_filename: Option<String>,
    pub from_folder: String,
    pub to_folder: String,
    pub undone: bool,
    pub created_at: i64, // Unix timestamp ms
}

// ============================================================
// DATABASE MANAGER
// ============================================================

/// Thread-safe database manager using Mutex-wrapped connection
pub struct Database {
    conn: Mutex<Connection>,
}

// Limits matching frontend constants
const MAX_CORRECTIONS: usize = 50;
const MAX_ACTIVITY_LOG: usize = 100;

impl Database {
    /// Initialize database at the given path, creating tables if needed
    pub fn new(db_path: PathBuf) -> Result<Self, DbError> {
        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| DbError::InitFailed(format!("Failed to create db directory: {}", e)))?;
        }

        let conn = Connection::open(&db_path)
            .map_err(|e| DbError::InitFailed(e.to_string()))?;

        // Enable WAL mode for better concurrency
        conn.execute_batch("PRAGMA journal_mode = WAL;")
            .map_err(|e| DbError::InitFailed(e.to_string()))?;

        let db = Database {
            conn: Mutex::new(conn),
        };

        db.run_migrations()?;

        Ok(db)
    }

    /// Create tables if they don't exist
    fn run_migrations(&self) -> Result<(), DbError> {
        let conn = self.conn.lock().unwrap();

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS corrections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                ai_suggested TEXT NOT NULL,
                user_chose TEXT NOT NULL,
                correction_type TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_corrections_created_at
                ON corrections(created_at);

            CREATE TABLE IF NOT EXISTS activity_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                from_folder TEXT NOT NULL,
                to_folder TEXT NOT NULL,
                undone INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_activity_created_at
                ON activity_log(created_at DESC);

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pattern TEXT NOT NULL,
                target_folder TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
        ",
        )
        .map_err(|e| DbError::InitFailed(e.to_string()))?;

        // Migration: add original_filename column for smart rename tracking
        let has_column: bool = conn
            .prepare("PRAGMA table_info(activity_log)")
            .and_then(|mut stmt| {
                let names: Vec<String> = stmt
                    .query_map([], |row| row.get::<_, String>(1))?
                    .filter_map(|r| r.ok())
                    .collect();
                Ok(names.contains(&"original_filename".to_string()))
            })
            .unwrap_or(false);

        if !has_column {
            conn.execute_batch("ALTER TABLE activity_log ADD COLUMN original_filename TEXT;")
                .map_err(|e| DbError::InitFailed(e.to_string()))?;
        }

        Ok(())
    }

    // --------------------------------------------------------
    // CORRECTIONS
    // --------------------------------------------------------

    /// Add a correction, enforcing the max limit
    pub fn add_correction(&self, correction: Correction) -> Result<i64, DbError> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO corrections (filename, ai_suggested, user_chose, correction_type, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                correction.filename,
                correction.ai_suggested,
                correction.user_chose,
                correction.correction_type,
                correction.created_at,
            ],
        )?;

        let id = conn.last_insert_rowid();

        // Enforce max limit - delete oldest entries beyond the limit
        conn.execute(
            "DELETE FROM corrections WHERE id NOT IN (
                SELECT id FROM corrections ORDER BY created_at DESC LIMIT ?1
            )",
            params![MAX_CORRECTIONS],
        )?;

        Ok(id)
    }

    /// Get all corrections (newest first)
    pub fn get_corrections(&self) -> Result<Vec<Correction>, DbError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, filename, ai_suggested, user_chose, correction_type, created_at
             FROM corrections ORDER BY created_at DESC",
        )?;

        let corrections = stmt
            .query_map([], |row| {
                Ok(Correction {
                    id: Some(row.get(0)?),
                    filename: row.get(1)?,
                    ai_suggested: row.get(2)?,
                    user_chose: row.get(3)?,
                    correction_type: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(corrections)
    }

    /// Clear all corrections
    pub fn clear_corrections(&self) -> Result<(), DbError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM corrections", [])?;
        Ok(())
    }

    // --------------------------------------------------------
    // ACTIVITY LOG
    // --------------------------------------------------------

    /// Add an activity entry, enforcing the max limit
    pub fn add_activity(&self, entry: ActivityEntry) -> Result<i64, DbError> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO activity_log (filename, original_filename, from_folder, to_folder, undone, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                entry.filename,
                entry.original_filename,
                entry.from_folder,
                entry.to_folder,
                entry.undone as i32,
                entry.created_at,
            ],
        )?;

        let id = conn.last_insert_rowid();

        // Enforce max limit
        conn.execute(
            "DELETE FROM activity_log WHERE id NOT IN (
                SELECT id FROM activity_log ORDER BY created_at DESC LIMIT ?1
            )",
            params![MAX_ACTIVITY_LOG],
        )?;

        Ok(id)
    }

    /// Get activity log (newest first)
    pub fn get_activity_log(&self) -> Result<Vec<ActivityEntry>, DbError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, filename, original_filename, from_folder, to_folder, undone, created_at
             FROM activity_log ORDER BY created_at DESC",
        )?;

        let entries = stmt
            .query_map([], |row| {
                Ok(ActivityEntry {
                    id: Some(row.get(0)?),
                    filename: row.get(1)?,
                    original_filename: row.get(2)?,
                    from_folder: row.get(3)?,
                    to_folder: row.get(4)?,
                    undone: row.get::<_, i32>(5)? != 0,
                    created_at: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(entries)
    }

    /// Mark an activity entry as undone by timestamp
    pub fn mark_activity_undone(&self, timestamp: i64) -> Result<bool, DbError> {
        let conn = self.conn.lock().unwrap();
        let updated = conn.execute(
            "UPDATE activity_log SET undone = 1 WHERE created_at = ?1",
            params![timestamp],
        )?;
        Ok(updated > 0)
    }

    /// Clear all activity entries
    pub fn clear_activity_log(&self) -> Result<(), DbError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM activity_log", [])?;
        Ok(())
    }

    // --------------------------------------------------------
    // MIGRATION FROM LOCALSTORAGE
    // --------------------------------------------------------

    // --------------------------------------------------------
    // SETTINGS
    // --------------------------------------------------------

    /// Store a setting value
    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), DbError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    /// Retrieve a setting value
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, DbError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        match stmt.query_row(params![key], |row| row.get(0)) {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DbError::QueryFailed(e.to_string())),
        }
    }

    // --------------------------------------------------------
    // RULES
    // --------------------------------------------------------

    /// Add a classification rule
    pub fn add_rule(&self, pattern: &str, target_folder: &str) -> Result<i64, DbError> {
        let conn = self.conn.lock().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        conn.execute(
            "INSERT INTO rules (pattern, target_folder, created_at) VALUES (?1, ?2, ?3)",
            params![pattern, target_folder, now],
        )?;

        Ok(conn.last_insert_rowid())
    }

    /// Get all classification rules
    pub fn get_rules(&self) -> Result<Vec<Rule>, DbError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, pattern, target_folder, created_at FROM rules ORDER BY created_at ASC",
        )?;

        let rules = stmt
            .query_map([], |row| {
                Ok(Rule {
                    id: Some(row.get(0)?),
                    pattern: row.get(1)?,
                    target_folder: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rules)
    }

    /// Delete a rule by id
    pub fn delete_rule(&self, id: i64) -> Result<bool, DbError> {
        let conn = self.conn.lock().unwrap();
        let deleted = conn.execute("DELETE FROM rules WHERE id = ?1", params![id])?;
        Ok(deleted > 0)
    }

    // --------------------------------------------------------
    // MIGRATION FROM LOCALSTORAGE
    // --------------------------------------------------------

    /// Import corrections from localStorage format
    pub fn import_corrections(&self, corrections: Vec<Correction>) -> Result<usize, DbError> {
        let conn = self.conn.lock().unwrap();
        let mut count = 0;

        for c in corrections {
            conn.execute(
                "INSERT OR IGNORE INTO corrections
                 (filename, ai_suggested, user_chose, correction_type, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    c.filename,
                    c.ai_suggested,
                    c.user_chose,
                    c.correction_type,
                    c.created_at
                ],
            )?;
            count += 1;
        }

        Ok(count)
    }

    /// Import activity log from localStorage format
    pub fn import_activity_log(&self, entries: Vec<ActivityEntry>) -> Result<usize, DbError> {
        let conn = self.conn.lock().unwrap();
        let mut count = 0;

        for e in entries {
            conn.execute(
                "INSERT OR IGNORE INTO activity_log
                 (filename, original_filename, from_folder, to_folder, undone, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    e.filename,
                    e.original_filename,
                    e.from_folder,
                    e.to_folder,
                    e.undone as i32,
                    e.created_at
                ],
            )?;
            count += 1;
        }

        Ok(count)
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;
    use std::sync::atomic::{AtomicU64, Ordering};

    // Atomic counter to ensure unique database paths for each test
    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_db() -> Database {
        let unique_id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = temp_dir().join(format!(
            "test_db_{}_{}.db",
            std::process::id(),
            unique_id
        ));
        // Remove any existing file from previous runs
        let _ = std::fs::remove_file(&path);
        Database::new(path).unwrap()
    }

    #[test]
    fn test_add_and_get_correction() {
        let db = temp_db();

        let correction = Correction {
            id: None,
            filename: "test.pdf".to_string(),
            ai_suggested: "Math".to_string(),
            user_chose: "Physics".to_string(),
            correction_type: "corrected".to_string(),
            created_at: 1234567890,
        };

        let id = db.add_correction(correction.clone()).unwrap();
        assert!(id > 0);

        let corrections = db.get_corrections().unwrap();
        assert_eq!(corrections.len(), 1);
        assert_eq!(corrections[0].filename, "test.pdf");
        assert_eq!(corrections[0].ai_suggested, "Math");
        assert_eq!(corrections[0].user_chose, "Physics");
    }

    #[test]
    fn test_correction_limit_enforced() {
        let db = temp_db();

        // Add more than MAX_CORRECTIONS
        for i in 0..60 {
            let correction = Correction {
                id: None,
                filename: format!("file{}.pdf", i),
                ai_suggested: "Folder".to_string(),
                user_chose: "Folder".to_string(),
                correction_type: "accepted".to_string(),
                created_at: i as i64,
            };
            db.add_correction(correction).unwrap();
        }

        let corrections = db.get_corrections().unwrap();
        assert_eq!(corrections.len(), MAX_CORRECTIONS);

        // Newest should be kept (highest created_at)
        assert_eq!(corrections[0].filename, "file59.pdf");
    }

    #[test]
    fn test_clear_corrections() {
        let db = temp_db();

        let correction = Correction {
            id: None,
            filename: "test.pdf".to_string(),
            ai_suggested: "Math".to_string(),
            user_chose: "Math".to_string(),
            correction_type: "accepted".to_string(),
            created_at: 1234567890,
        };
        db.add_correction(correction).unwrap();

        db.clear_corrections().unwrap();
        let corrections = db.get_corrections().unwrap();
        assert!(corrections.is_empty());
    }

    #[test]
    fn test_add_and_get_activity() {
        let db = temp_db();

        let entry = ActivityEntry {
            id: None,
            filename: "notes.pdf".to_string(),
            original_filename: None,
            from_folder: "Downloads".to_string(),
            to_folder: "Math".to_string(),
            undone: false,
            created_at: 1234567890,
        };

        let id = db.add_activity(entry.clone()).unwrap();
        assert!(id > 0);

        let entries = db.get_activity_log().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].filename, "notes.pdf");
        assert!(!entries[0].undone);
    }

    #[test]
    fn test_mark_activity_undone() {
        let db = temp_db();

        let entry = ActivityEntry {
            id: None,
            filename: "notes.pdf".to_string(),
            original_filename: None,
            from_folder: "Downloads".to_string(),
            to_folder: "Math".to_string(),
            undone: false,
            created_at: 1234567890,
        };
        db.add_activity(entry).unwrap();

        let updated = db.mark_activity_undone(1234567890).unwrap();
        assert!(updated);

        let entries = db.get_activity_log().unwrap();
        assert!(entries[0].undone);
    }

    #[test]
    fn test_mark_activity_undone_not_found() {
        let db = temp_db();
        let updated = db.mark_activity_undone(9999999999).unwrap();
        assert!(!updated);
    }

    #[test]
    fn test_activity_limit_enforced() {
        let db = temp_db();

        // Add more than MAX_ACTIVITY_LOG
        for i in 0..110 {
            let entry = ActivityEntry {
                id: None,
                filename: format!("file{}.pdf", i),
                original_filename: None,
                from_folder: "Downloads".to_string(),
                to_folder: "Folder".to_string(),
                undone: false,
                created_at: i as i64,
            };
            db.add_activity(entry).unwrap();
        }

        let entries = db.get_activity_log().unwrap();
        assert_eq!(entries.len(), MAX_ACTIVITY_LOG);

        // Newest should be kept
        assert_eq!(entries[0].filename, "file109.pdf");
    }

    #[test]
    fn test_import_corrections() {
        let db = temp_db();

        let corrections = vec![
            Correction {
                id: None,
                filename: "a.pdf".to_string(),
                ai_suggested: "Math".to_string(),
                user_chose: "Math".to_string(),
                correction_type: "accepted".to_string(),
                created_at: 1000,
            },
            Correction {
                id: None,
                filename: "b.pdf".to_string(),
                ai_suggested: "Physics".to_string(),
                user_chose: "Chemistry".to_string(),
                correction_type: "corrected".to_string(),
                created_at: 2000,
            },
        ];

        let count = db.import_corrections(corrections).unwrap();
        assert_eq!(count, 2);

        let result = db.get_corrections().unwrap();
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_import_activity_log() {
        let db = temp_db();

        let entries = vec![
            ActivityEntry {
                id: None,
                filename: "a.pdf".to_string(),
                original_filename: None,
                from_folder: "Downloads".to_string(),
                to_folder: "Math".to_string(),
                undone: false,
                created_at: 1000,
            },
            ActivityEntry {
                id: None,
                filename: "b.pdf".to_string(),
                original_filename: None,
                from_folder: "Downloads".to_string(),
                to_folder: "Physics".to_string(),
                undone: true,
                created_at: 2000,
            },
        ];

        let count = db.import_activity_log(entries).unwrap();
        assert_eq!(count, 2);

        let result = db.get_activity_log().unwrap();
        assert_eq!(result.len(), 2);
        assert!(result[0].undone || result[1].undone); // One should be undone
    }

    #[test]
    fn test_add_and_get_rules() {
        let db = temp_db();

        let id1 = db.add_rule("*_ML_*", "C:\\Courses\\ML").unwrap();
        let id2 = db.add_rule("Lecture*", "C:\\Courses\\Lectures").unwrap();
        assert!(id1 > 0);
        assert!(id2 > 0);

        let rules = db.get_rules().unwrap();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].pattern, "*_ML_*");
        assert_eq!(rules[1].pattern, "Lecture*");
    }

    #[test]
    fn test_delete_rule() {
        let db = temp_db();

        let id = db.add_rule("*.pdf", "C:\\PDFs").unwrap();
        assert!(db.delete_rule(id).unwrap());

        let rules = db.get_rules().unwrap();
        assert!(rules.is_empty());
    }

    #[test]
    fn test_delete_nonexistent_rule() {
        let db = temp_db();
        assert!(!db.delete_rule(999).unwrap());
    }
}
