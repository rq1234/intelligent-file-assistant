// ============================================================
// APPLICATION CONSTANTS
// ============================================================

// localStorage keys for persisting user config
export const STORAGE_KEYS = {
  modules: "fileorg_modules",
  basePath: "fileorg_base_path",
  onboarded: "fileorg_onboarded",
  corrections: "fileorg_corrections",
  activityLog: "fileorg_activity_log",
  watchPath: "fileorg_watch_path",
  autoMoveEnabled: "fileorg_auto_move_enabled",
  autoMoveThreshold: "fileorg_auto_move_threshold",
  notificationsEnabled: "fileorg_notifications_enabled",
  lastScanFolder: "fileorg_last_scan_folder",
  windowState: "fileorg_window_state",
  theme: "fileorg_theme",
};

// Limits
export const MAX_CORRECTIONS = 50;
export const MAX_ACTIVITY_LOG = 100;

// Undo
export const UNDO_TIMEOUT_MS = 10000;

// Batch detection thresholds
export const RAPID_WINDOW_MS = 2000;
export const BATCH_WINDOW_MS = 5000;
export const MIN_BATCH_SIZE = 3;

// Classification
export const CONFIDENCE_THRESHOLD = 0.7;

// File type extensions
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
export const CONTENT_EXTRACTABLE_EXTENSIONS = ["pdf", "txt", "md", "csv"];

// Retry delays for file-in-use scenarios (ms)
export const QUICK_RETRY_DELAYS = [2000, 5000, 10000, 30000, 60000];
export const PATIENT_RETRY_DELAY_MS = 600000;
export const QUICK_RETRY_COUNT = 5;

// UI timing
export const STATUS_TIMEOUT_MS = 5000;
export const ONBOARDING_STATUS_TIMEOUT_MS = 4000;
export const FILE_REMOVE_ANIMATION_MS = 300;

// Validation
export const MAX_MODULE_NAME_LENGTH = 100;
export const INVALID_FILENAME_CHARS = /[<>:"|?*]/;
