// ============================================================
// CENTRALIZED APPLICATION STATE
// ============================================================
// All mutable application state lives here in a single object.
// This makes it easy to find, debug, and eventually replace
// with a more structured state management approach.

const state = {
  // Watch folder
  watchPath: "",
  isWatching: false,

  // Detected files in the UI
  detectedFiles: [],

  // Batch detection
  pendingBatch: [],
  batchTimer: null,

  // User config (loaded from localStorage)
  userModules: [],
  basePath: "",

  // Skipped files (AI deemed non-educational)
  skippedFiles: [],

  // Ignored files (user-dismissed)
  ignoredFiles: [],

  // Correction history for AI learning
  correctionLog: [],

  // Activity log
  activityLog: [],

  // Undo state
  undoTimer: null,
  undoCountdownInterval: null,
  lastMove: null,

  // Auto-move settings
  autoMoveEnabled: false,
  autoMoveThreshold: 0.9,

  // Notification settings
  notificationsEnabled: false,
  notificationApi: null,

  // Theme
  darkModeEnabled: false,
};

export default state;
