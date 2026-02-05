// Storage abstraction layer for SQLite database
// Provides async functions to interact with the Rust backend database

const { invoke } = window.__TAURI__.core;

// Migration flag key in localStorage
const MIGRATION_DONE_KEY = "fileorg_sqlite_migrated";

// ============================================================
// CORRECTIONS
// ============================================================

/**
 * Add a correction to the database
 * @param {string} filename - The file that was classified
 * @param {string} aiSuggested - The folder AI suggested
 * @param {string} userChose - The folder user actually chose
 * @param {string} type - "accepted", "corrected", or "dismissed"
 */
export async function addCorrection(filename, aiSuggested, userChose, type) {
  try {
    await invoke("db_add_correction", {
      filename,
      aiSuggested,
      userChose,
      correctionType: type,
    });
  } catch (e) {
    console.error("[Storage] Failed to add correction:", e);
  }
}

/**
 * Get all corrections from the database
 * @returns {Promise<Array>} Array of correction objects
 */
export async function getCorrections() {
  try {
    const corrections = await invoke("db_get_corrections");
    // Map from Rust struct format to JS format
    return corrections.map((c) => ({
      filename: c.filename,
      aiSuggested: c.ai_suggested,
      userChose: c.user_chose,
      type: c.correction_type,
      timestamp: c.created_at,
    }));
  } catch (e) {
    console.error("[Storage] Failed to get corrections:", e);
    return [];
  }
}

/**
 * Clear all corrections from the database
 */
export async function clearCorrections() {
  try {
    await invoke("db_clear_corrections");
  } catch (e) {
    console.error("[Storage] Failed to clear corrections:", e);
  }
}

// ============================================================
// ACTIVITY LOG
// ============================================================

/**
 * Add an activity entry to the database
 * @param {string} filename - The file that was moved
 * @param {string} fromFolder - Source folder path
 * @param {string} toFolder - Destination folder path
 * @returns {Promise<Object|null>} The created entry or null on failure
 */
export async function addActivity(filename, fromFolder, toFolder) {
  try {
    await invoke("db_add_activity", {
      filename,
      fromFolder,
      toFolder,
    });
    // Return the entry in the format expected by the frontend
    return {
      filename,
      from: fromFolder,
      to: toFolder,
      timestamp: Date.now(),
      undone: false,
    };
  } catch (e) {
    console.error("[Storage] Failed to add activity:", e);
    return null;
  }
}

/**
 * Get all activity log entries from the database
 * @returns {Promise<Array>} Array of activity entry objects
 */
export async function getActivityLog() {
  try {
    const entries = await invoke("db_get_activity_log");
    // Map from Rust struct format to JS format
    return entries.map((e) => ({
      filename: e.filename,
      from: e.from_folder,
      to: e.to_folder,
      timestamp: e.created_at,
      undone: e.undone,
    }));
  } catch (e) {
    console.error("[Storage] Failed to get activity log:", e);
    return [];
  }
}

/**
 * Mark an activity entry as undone by timestamp
 * @param {number} timestamp - The timestamp of the entry to mark as undone
 */
export async function markActivityUndone(timestamp) {
  try {
    await invoke("db_mark_activity_undone", { timestamp });
  } catch (e) {
    console.error("[Storage] Failed to mark activity undone:", e);
  }
}

/**
 * Clear all activity log entries from the database
 */
export async function clearActivityLog() {
  try {
    await invoke("db_clear_activity_log");
  } catch (e) {
    console.error("[Storage] Failed to clear activity log:", e);
  }
}

// ============================================================
// MIGRATION FROM LOCALSTORAGE
// ============================================================

/**
 * Migrate existing data from localStorage to SQLite database.
 * This should be called once on app startup.
 * Data is preserved in localStorage as a backup.
 */
export async function migrateFromLocalStorage() {
  // Check if migration has already been done
  if (localStorage.getItem(MIGRATION_DONE_KEY) === "true") {
    console.log("[Storage] Migration already completed, skipping");
    return;
  }

  console.log("[Storage] Starting migration from localStorage to SQLite...");

  try {
    // Get existing data from localStorage
    const correctionsJson = localStorage.getItem("fileorg_corrections");
    const activityJson = localStorage.getItem("fileorg_activity_log");

    const corrections = correctionsJson ? JSON.parse(correctionsJson) : [];
    const activityLog = activityJson ? JSON.parse(activityJson) : [];

    if (corrections.length === 0 && activityLog.length === 0) {
      console.log("[Storage] No data to migrate");
      localStorage.setItem(MIGRATION_DONE_KEY, "true");
      return;
    }

    // Convert to Rust struct format for import
    const rustCorrections = corrections.map((c) => ({
      id: null,
      filename: c.filename,
      ai_suggested: c.aiSuggested,
      user_chose: c.userChose,
      correction_type: c.type,
      created_at: c.timestamp,
    }));

    const rustActivity = activityLog.map((e) => ({
      id: null,
      filename: e.filename,
      from_folder: e.from,
      to_folder: e.to,
      undone: e.undone || false,
      created_at: e.timestamp,
    }));

    // Import to SQLite
    const [corrCount, actCount] = await invoke("db_import_from_localstorage", {
      corrections: rustCorrections,
      activityLog: rustActivity,
    });

    console.log(
      `[Storage] Migrated ${corrCount} corrections and ${actCount} activity entries`
    );

    // Mark migration as complete (keep localStorage data as backup)
    localStorage.setItem(MIGRATION_DONE_KEY, "true");
  } catch (e) {
    console.error("[Storage] Migration failed:", e);
    // Don't set the flag so it tries again next time
  }
}
