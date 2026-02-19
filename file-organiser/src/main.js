import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { openPath } from "@tauri-apps/plugin-opener";

// state.js documents all mutable state in one place for future refactoring
// import state from "./state.js";
import {
  STORAGE_KEYS,
  UNDO_TIMEOUT_MS,
  BATCH_WINDOW_MS,
  CONFIDENCE_THRESHOLD,
  QUICK_RETRY_DELAYS,
  PATIENT_RETRY_DELAY_MS,
  QUICK_RETRY_COUNT,
  STATUS_TIMEOUT_MS,
  ONBOARDING_STATUS_TIMEOUT_MS,
  FILE_REMOVE_ANIMATION_MS,
} from "./constants.js";
import {
  formatFileSize,
  escapeHtml,
  getFileExt,
  getFileTypeIcon,
  isImageFile,
  isContentExtractable,
  isToday,
  shouldGroupAsBatch,
  validateModuleName,
  buildCorrectionHistory,
  filterNewFiles,
  getCachedClassification,
  matchRule,
  pathJoin,
  pathBasename,
} from "./utils.js";
import { getErrorMessage, isLockedFileError, isDuplicateError } from "./errors.js";
import { showOnboardingScreen, initOnboarding } from "./onboarding.js";
import { showSettingsScreen, initSettings } from "./settings.js";
import {
  addCorrection as dbAddCorrection,
  getCorrections as dbGetCorrections,
  addActivity as dbAddActivity,
  getActivityLog as dbGetActivityLog,
  markActivityUndone as dbMarkActivityUndone,
  clearActivityLog as dbClearActivityLog,
  migrateFromLocalStorage,
  getRules as dbGetRules,
} from "./storage.js";

// ============================================================
// STATE (module-scope bindings backed by state.js)
// ============================================================
let watchPath = "";
let detectedFiles = [];
let isWatching = false;
let pendingBatch = [];
let batchTimer = null;
let userModules = [];
let basePath = "";
let skippedFiles = [];
let ignoredFiles = [];
let correctionLog = [];
let activityLog = [];
let undoTimer = null;
let undoCountdownInterval = null;
let lastMove = null;
let autoMoveEnabled = false;
let autoMoveThreshold = 0.9;
let notificationsEnabled = false;
let notificationApi = null;
let darkModeEnabled = false;
let classificationRules = [];

function applyTheme() {
  document.documentElement.setAttribute("data-theme", darkModeEnabled ? "dark" : "light");
}

// ============================================================
// INITIALIZATION
// ============================================================
// Restore saved window position & size from localStorage
async function restoreWindowState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.windowState);
    if (!saved) return;
    const state = JSON.parse(saved);
    if (!state.width || !state.height) return;
    const appWindow = getCurrentWindow();
    await appWindow.setSize(new LogicalSize(state.width, state.height));
    if (state.x !== undefined && state.y !== undefined) {
      await appWindow.setPosition(new LogicalPosition(state.x, state.y));
    }
  } catch (e) {
    console.error("Failed to restore window state:", e);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  // Check if user has already completed onboarding
  const isOnboarded = localStorage.getItem(STORAGE_KEYS.onboarded) === "true";

  // Restore saved window position & size
  restoreWindowState();

  // Save window state on resize/move (debounced)
  let windowStateTimer = null;
  const saveWindowState = async () => {
    clearTimeout(windowStateTimer);
    windowStateTimer = setTimeout(async () => {
      try {
        const appWindow = getCurrentWindow();
        const size = await appWindow.innerSize();
        const pos = await appWindow.outerPosition();
        localStorage.setItem(STORAGE_KEYS.windowState, JSON.stringify({
          x: pos.x, y: pos.y, width: size.width, height: size.height,
        }));
      } catch (e) {
        console.error("Failed to save window state:", e);
      }
    }, 500);
  };
  listen("tauri://resize", saveWindowState);
  listen("tauri://move", saveWindowState);

  // Minimize to system tray on close instead of quitting
  const appWindow = getCurrentWindow();
  appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    await appWindow.hide();
    // Show a notification the first time so user knows app is still running
    const firstHide = localStorage.getItem("fileorg_first_tray_hide");
    if (!firstHide) {
      sendAppNotification("File Organizer still running", "App minimized to system tray. Right-click tray icon to quit.");
      localStorage.setItem("fileorg_first_tray_hide", "true");
    }
  });

  if (isOnboarded) {
    loadSavedConfig();
    showAppScreen();
  } else {
    const onboardingState = { userModules, basePath };
    showOnboardingScreen(() => initOnboarding(onboardingState, {
      onComplete() {
        userModules = onboardingState.userModules;
        basePath = onboardingState.basePath;
        showAppScreen();
      }
    }));
  }
});

async function loadSavedConfig() {
  try {
    // Load settings from localStorage FIRST (synchronous, available immediately).
    // This ensures watchPath/userModules are set before checkWatcherState() runs,
    // even though this function is not awaited by its callers.
    const savedModules = localStorage.getItem(STORAGE_KEYS.modules);
    const savedBasePath = localStorage.getItem(STORAGE_KEYS.basePath);
    const savedWatchPath = localStorage.getItem(STORAGE_KEYS.watchPath);
    const savedAutoMove = localStorage.getItem(STORAGE_KEYS.autoMoveEnabled);
    const savedThreshold = localStorage.getItem(STORAGE_KEYS.autoMoveThreshold);
    if (savedModules) {
      const parsed = JSON.parse(savedModules);
      if (Array.isArray(parsed)) userModules = parsed.filter(m => typeof m === "string");
    }
    if (savedBasePath) basePath = savedBasePath;
    if (savedWatchPath) watchPath = savedWatchPath;
    const savedNotifications = localStorage.getItem(STORAGE_KEYS.notificationsEnabled);
    if (savedNotifications !== null) notificationsEnabled = savedNotifications === "true";
    if (savedAutoMove !== null) autoMoveEnabled = savedAutoMove === "true";
    if (savedThreshold !== null) {
      const t = parseFloat(savedThreshold);
      if (!isNaN(t)) autoMoveThreshold = Math.min(1.0, Math.max(0.7, t));
    }
    const savedTheme = localStorage.getItem(STORAGE_KEYS.theme);
    if (savedTheme) {
      darkModeEnabled = savedTheme === "dark";
    } else {
      darkModeEnabled = window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    applyTheme();

    // Async DB operations (callers don't await, so these run in background)
    await migrateFromLocalStorage();
    correctionLog = await dbGetCorrections();
    activityLog = await dbGetActivityLog();
    try { classificationRules = await dbGetRules(); } catch (e) { classificationRules = []; }

    // Migrate API key from localStorage to secure Rust-side storage (one-time)
    const oldApiKey = localStorage.getItem(STORAGE_KEYS.apiKey);
    if (oldApiKey) {
      try {
        await invoke("set_api_key", { key: oldApiKey });
        localStorage.removeItem(STORAGE_KEYS.apiKey);
        console.log("[MIGRATION] API key migrated from localStorage to secure storage");
      } catch (e) {
        console.error("Failed to migrate API key:", e);
      }
    }
  } catch (e) {
    console.error("Failed to load saved config:", e);
  }
}

// Initialize the notification API (dynamic import)
async function initNotifications() {
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    notificationApi = mod;

    // When user clicks a notification, bring the app window to focus
    mod.onAction(() => {
      const appWindow = getCurrentWindow();
      appWindow.show();
      appWindow.unminimize();
      appWindow.setFocus();
    });

    if (notificationsEnabled) {
      const granted = await mod.isPermissionGranted();
      if (!granted) {
        const permission = await mod.requestPermission();
        if (permission !== "granted") {
          notificationsEnabled = false;
          localStorage.setItem(STORAGE_KEYS.notificationsEnabled, "false");
        }
      }
    }
  } catch (e) {
    console.error("Failed to load notification plugin:", e);
    notificationApi = null;
  }
}

// Send a notification if enabled
function sendAppNotification(title, body) {
  if (!notificationsEnabled || !notificationApi) return;
  try {
    // Prefix with app name for clarity (especially in dev mode where app name shows as PowerShell)
    notificationApi.sendNotification({
      title: `📁 ${title}`,
      body
    });
  } catch (e) {
    console.error("Notification failed:", e);
  }
}

// Save a correction to the log (async, uses SQLite)
async function logCorrection(filename, aiSuggested, userChose, type) {
  // Save to SQLite database
  await dbAddCorrection(filename, aiSuggested, userChose, type);
  // Update in-memory log
  correctionLog = await dbGetCorrections();
  console.log(`[CORRECTION] ${type}: "${filename}" | AI said "${aiSuggested}" → User chose "${userChose}"`);
}

// buildCorrectionHistory is imported from utils.js

// Save an activity log entry (async, uses SQLite)
async function addActivityEntry(filename, fromFolder, toFolder, originalFilename = null) {
  // Save to SQLite database
  const entry = await dbAddActivity(filename, fromFolder, toFolder, originalFilename);
  // Update in-memory log
  activityLog = await dbGetActivityLog();
  return entry;
}

// Mark the most recent activity entry as undone (async, uses SQLite)
async function markActivityUndone(timestamp) {
  await dbMarkActivityUndone(timestamp);
  // Update in-memory log
  activityLog = await dbGetActivityLog();
}

// ============================================================
// MAIN APP SCREEN
// ============================================================
function showAppScreen() {
  document.getElementById("onboarding-screen").style.display = "none";
  document.getElementById("settings-screen").style.display = "none";
  document.getElementById("app-screen").style.display = "block";
  loadSavedConfig();
  initNotifications();
  initApp();
}

function updateConfigSummary() {
  const summary = document.querySelector("#config-summary");
  if (!summary) return;
  const watchDisplay = watchPath ? pathBasename(watchPath) : "Not set";
  const moduleCount = userModules.length;
  const autoMoveDisplay = autoMoveEnabled ? `Auto-move: ${Math.round(autoMoveThreshold * 100)}%+` : "Auto-move: off";
  summary.innerHTML = `<strong>Watching:</strong> ${escapeHtml(watchDisplay)} &nbsp;|&nbsp; <strong>${moduleCount}</strong> modules &nbsp;|&nbsp; ${autoMoveDisplay}`;

  // Update scan button state based on modules
  const scanFolderBtn = document.querySelector("#scan-folder-btn");
  if (scanFolderBtn) {
    scanFolderBtn.disabled = userModules.length === 0;
  }
}

function initApp() {
  // DOM Elements
  const settingsBtn = document.querySelector("#settings-btn");
  const startWatchingBtn = document.querySelector("#start-watching-btn");
  const statusMsg = document.querySelector("#status-msg");
  const fileList = document.querySelector("#file-list");
  const fileCount = document.querySelector("#file-count");
  const batchActions = document.querySelector("#batch-actions");
  const acceptAllHighBtn = document.querySelector("#accept-all-high-btn");
  const highConfidenceCount = document.querySelector("#high-confidence-count");
  const dismissAllBtn = document.querySelector("#dismiss-all-btn");
  const skippedSection = document.querySelector("#skipped-section");
  const skippedCountEl = document.querySelector("#skipped-count");
  const reviewSkippedBtn = document.querySelector("#review-skipped-btn");
  const skippedList = document.querySelector("#skipped-list");
  const ignoredSection = document.querySelector("#ignored-section");
  const ignoredCountEl = document.querySelector("#ignored-count");
  const reviewIgnoredBtn = document.querySelector("#review-ignored-btn");
  const ignoredList = document.querySelector("#ignored-list");
  const activityList = document.querySelector("#activity-list");
  const activityCount = document.querySelector("#activity-count");
  const clearActivityBtn = document.querySelector("#clear-activity-btn");
  const undoToast = document.querySelector("#undo-toast");
  const undoToastMsg = document.querySelector("#undo-toast-msg");
  const undoBtn = document.querySelector("#undo-btn");
  const undoCountdownEl = document.querySelector("#undo-countdown");
  const undoProgress = document.querySelector("#undo-progress");
  const scanFolderBtn = document.querySelector("#scan-folder-btn");
  const scanProgress = document.querySelector("#scan-progress");
  const scanProgressCount = document.querySelector("#scan-progress-count");
  const scanProgressFill = document.querySelector("#scan-progress-fill");
  const scanCancelBtn = document.querySelector("#scan-cancel-btn");
  const scanLimitSelect = document.querySelector("#scan-limit");
  const scanLimitCustom = document.querySelector("#scan-limit-custom");
  let scanInProgress = false;
  let scanCancelled = false;
  let skippedExpanded = false;

  // Wire up skipped files review toggle
  reviewSkippedBtn.addEventListener("click", () => {
    skippedExpanded = !skippedExpanded;
    skippedList.style.display = skippedExpanded ? "block" : "none";
    reviewSkippedBtn.textContent = skippedExpanded ? "Hide" : "Review";
  });

  // Wire up ignored files review toggle
  let ignoredExpanded = false;
  reviewIgnoredBtn.addEventListener("click", () => {
    ignoredExpanded = !ignoredExpanded;
    ignoredList.style.display = ignoredExpanded ? "block" : "none";
    reviewIgnoredBtn.textContent = ignoredExpanded ? "Hide" : "Review";
  });

  // Wire up undo button
  undoBtn.addEventListener("click", handleUndo);

  // Wire up clear activity log
  clearActivityBtn.addEventListener("click", async () => {
    await dbClearActivityLog();
    activityLog = [];
    renderActivityLog();
  });

  // Render existing activity log
  renderActivityLog();

  // Settings button -> settings screen
  settingsBtn.addEventListener("click", () => {
    const settingsState = {
      basePath, watchPath, userModules, autoMoveEnabled, autoMoveThreshold,
      notificationsEnabled, darkModeEnabled, classificationRules, notificationApi,
    };
    showSettingsScreen(() => initSettings(settingsState, {
      onClose() {
        basePath = settingsState.basePath;
        watchPath = settingsState.watchPath;
        userModules = settingsState.userModules;
        autoMoveEnabled = settingsState.autoMoveEnabled;
        autoMoveThreshold = settingsState.autoMoveThreshold;
        notificationsEnabled = settingsState.notificationsEnabled;
        darkModeEnabled = settingsState.darkModeEnabled;
        classificationRules = settingsState.classificationRules;
        updateConfigSummary();
      },
      applyTheme() { applyTheme(); },
    }));
  });

  // Set up event listeners
  startWatchingBtn.addEventListener("click", toggleWatching);
  acceptAllHighBtn.addEventListener("click", acceptAllHighConfidence);
  dismissAllBtn.addEventListener("click", dismissAll);
  scanFolderBtn.addEventListener("click", startBulkScan);
  scanCancelBtn.addEventListener("click", () => { scanCancelled = true; });

  // Show/hide custom input when "Custom" is selected
  scanLimitSelect.addEventListener("change", () => {
    scanLimitCustom.style.display = scanLimitSelect.value === "custom" ? "inline-block" : "none";
    if (scanLimitSelect.value === "custom") {
      scanLimitCustom.focus();
    }
  });

  // Listen for file detection events from Rust
  setupFileListener();

  // Listen for tray hint notification
  setupTrayHintListener();

  // Set up drag & drop on app window
  setupDragAndDrop();

  // Set up keyboard shortcuts
  setupKeyboardShortcuts();

  // Watch path must be configured by the user via Settings > Browse
  scanFolderBtn.disabled = userModules.length === 0;
  updateConfigSummary();

  // Check if watcher is already running (e.g. after navigating back from Settings)
  checkWatcherState();

  // --- Build available folders from user modules ---
  function getAvailableFolders() {
    return userModules.map(name => pathJoin(basePath, name));
  }

  // --- Build folder select options ---
  function buildFolderOptions() {
    let options = '<option value="">Choose destination...</option>';
    for (const name of userModules) {
      const fullPath = pathJoin(basePath, name);
      options += `<option value="${escapeHtml(fullPath)}">${escapeHtml(name)}</option>`;
    }
    return options;
  }

  // Quick-create a module from an unsorted file card (inline input, no prompt())
  function quickCreateModule(fileInfo, fileItem, classification) {
    const suggestionDiv = fileItem.querySelector(".ai-suggestion");
    if (!suggestionDiv) return;

    // If inline input already open, just focus it
    const existingInput = suggestionDiv.querySelector(".inline-module-input");
    if (existingInput) {
      existingInput.querySelector("input").focus();
      return;
    }

    // Hide the "+ Create Module" button and show inline input
    const createBtn = suggestionDiv.querySelector(".create-module-btn");
    if (createBtn) createBtn.style.display = "none";

    const inputDiv = document.createElement("div");
    inputDiv.className = "inline-module-input";
    inputDiv.innerHTML = `
      <input type="text" class="module-name-input" placeholder="e.g. Machine Learning" />
      <button class="confirm-create-btn">Create</button>
      <button class="cancel-create-btn">Cancel</button>
    `;

    const aiResult = suggestionDiv.querySelector(".ai-result");
    if (aiResult) {
      aiResult.appendChild(inputDiv);
    } else {
      suggestionDiv.appendChild(inputDiv);
    }

    const input = inputDiv.querySelector(".module-name-input");
    input.focus();

    const cancelInline = () => {
      inputDiv.remove();
      if (createBtn) createBtn.style.display = "";
    };

    const doCreate = async () => {
      const name = input.value;
      if (!name || !name.trim()) return;

      const trimmed = name.trim();
      const validationError = validateModuleName(trimmed);
      if (validationError) {
        showStatus(validationError, "error");
        return;
      }
      if (userModules.some(m => m.toLowerCase() === trimmed.toLowerCase())) {
        showStatus("Module already exists", "error");
        return;
      }

      // Add module
      userModules.push(trimmed);
      localStorage.setItem(STORAGE_KEYS.modules, JSON.stringify(userModules));

      // Create the folder
      const fullPath = pathJoin(basePath, trimmed);
      try {
        await invoke("create_folder", { path: fullPath });
      } catch (e) {
        console.error(`Failed to create folder for ${trimmed}:`, e);
      }

      // Update all folder dropdowns on existing cards
      const newOptions = buildFolderOptions();
      document.querySelectorAll(".folder-select").forEach(sel => {
        const currentVal = sel.value;
        sel.innerHTML = newOptions;
        sel.value = currentVal;
      });

      // Auto-select the new module in this card's dropdown
      const folderSelect = fileItem.querySelector(".folder-select");
      if (folderSelect) {
        folderSelect.value = fullPath;
      }

      // Update suggestion display
      suggestionDiv.innerHTML = `
        <div class="ai-result high">
          <strong>New module:</strong> ${escapeHtml(trimmed)}
          <button class="accept-btn">Move Here</button>
        </div>
        <div class="ai-reasoning">${escapeHtml(classification.reasoning)}</div>
      `;
      suggestionDiv.querySelector(".accept-btn").addEventListener("click", function() {
        acceptAISuggestion(fileInfo.path, fullPath, this);
      });

      updateConfigSummary();
      scanFolderBtn.disabled = false;
      showStatus(`Module "${trimmed}" created`, "success");
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doCreate(); }
      if (e.key === "Escape") cancelInline();
      e.stopPropagation(); // Prevent global keyboard shortcuts while typing
    });
    input.addEventListener("keyup", (e) => e.stopPropagation());
    inputDiv.querySelector(".confirm-create-btn").addEventListener("click", doCreate);
    inputDiv.querySelector(".cancel-create-btn").addEventListener("click", cancelInline);
  }

  // Check watcher state on init (handles returning from Settings)
  async function checkWatcherState() {
    try {
      const running = await invoke("is_watcher_running");
      isWatching = running;
      updateWatchButton();
      if (running) {
        showStatus(`Watching ${watchPath}`, "success");
      } else if (watchPath && userModules.length > 0) {
        // Auto-start watching if watch path and modules are configured
        try {
          await invoke("start_watching", { path: watchPath });
          isWatching = true;
          updateWatchButton();
          showStatus(`Watching ${watchPath}`, "success");
        } catch (autoErr) {
          console.error("Auto-start watching failed:", autoErr);
          showStatus("Ready to watch", "info");
        }
      } else {
        showStatus("Ready to watch", "info");
      }
    } catch (e) {
      console.error("Failed to check watcher state:", e);
      showStatus("Ready to watch", "info");
    }
  }

  // Update button text/style based on watcher state
  function updateWatchButton() {
    if (isWatching) {
      startWatchingBtn.textContent = "Stop Watching";
      startWatchingBtn.disabled = false;
      startWatchingBtn.classList.add("watching");
    } else {
      startWatchingBtn.textContent = "Start Watching";
      startWatchingBtn.disabled = false;
      startWatchingBtn.classList.remove("watching");
    }
  }

  // Toggle watching on/off
  async function toggleWatching() {
    if (isWatching) {
      // Stop watching
      try {
        await invoke("stop_watching");
        isWatching = false;
        updateWatchButton();
        showStatus("Stopped watching", "info");
      } catch (error) {
        showStatus(`Failed to stop watching: ${error}`, "error");
      }
    } else {
      // Start watching
      if (!watchPath) {
        showStatus("Please select a folder first", "error");
        return;
      }
      try {
        await invoke("start_watching", { path: watchPath });
        isWatching = true;
        updateWatchButton();
        showStatus(`Watching ${watchPath}`, "success");
      } catch (error) {
        showStatus(`Failed to start watching: ${error}`, "error");
      }
    }
  }

  // Bulk scan: scan existing files in a chosen folder
  async function startBulkScan() {
    if (scanInProgress) {
      showStatus("Scan already in progress", "info");
      return;
    }
    if (userModules.length === 0) {
      showStatus("Please add modules first in Settings", "error");
      return;
    }

    try {
      // Open folder picker — default to last scanned folder
      const lastScanFolder = localStorage.getItem(STORAGE_KEYS.lastScanFolder) || undefined;
      const selectedPath = await open({
        directory: true,
        title: "Select folder to scan",
        defaultPath: lastScanFolder,
      });
      if (!selectedPath) return; // User cancelled

      // Remember this folder for next time
      localStorage.setItem(STORAGE_KEYS.lastScanFolder, selectedPath);

      scanInProgress = true;
      scanCancelled = false;
      scanFolderBtn.disabled = true;

      // Get list of files from Rust
      showStatus(`Scanning ${selectedPath}...`, "info");
      const files = await invoke("scan_files", { path: selectedPath });

      if (files.length === 0) {
        showStatus("No files found in selected folder", "info");
        scanInProgress = false;
        scanFolderBtn.disabled = false;
        return;
      }

      // Filter out files already tracked
      const existingPaths = new Set([
        ...detectedFiles.map(f => f.path),
        ...skippedFiles.map(f => f.path),
        ...ignoredFiles.map(f => f.path),
      ]);
      let newFiles = files.filter(f => !existingPaths.has(f.path));

      if (newFiles.length === 0) {
        showStatus("All files in this folder are already tracked", "info");
        scanInProgress = false;
        scanFolderBtn.disabled = false;
        return;
      }

      // Apply scan limit
      let scanLimit;
      if (scanLimitSelect.value === "custom") {
        scanLimit = parseInt(scanLimitCustom.value, 10) || 0;
      } else {
        scanLimit = parseInt(scanLimitSelect.value, 10);
      }
      if (scanLimit > 0 && newFiles.length > scanLimit) {
        newFiles = newFiles.slice(0, scanLimit);
      }

      // Show progress bar
      scanProgress.style.display = "flex";
      scanProgressFill.style.width = "0%";
      scanProgressCount.textContent = `0/${newFiles.length}`;

      // Process files sequentially, tracking outcomes
      let processed = 0;
      let scanAutoMoved = 0;
      let scanNeedReview = 0;
      let scanSkipped = 0;
      for (const file of newFiles) {
        if (scanCancelled) {
          break;
        }

        const skippedBefore = skippedFiles.length;

        file.timestamp = Date.now();
        await addDetectedFile(file);
        processed++;

        // Determine outcome: auto-moved (not in detected or skipped), skipped, or needs review
        const wasSkipped = skippedFiles.length > skippedBefore;
        const stillInDetected = detectedFiles.some(f => f.path === file.path);
        if (wasSkipped) {
          scanSkipped++;
        } else if (!stillInDetected) {
          scanAutoMoved++;
        } else {
          scanNeedReview++;
        }

        // Update progress
        const pct = Math.round((processed / newFiles.length) * 100);
        scanProgressFill.style.width = `${pct}%`;
        scanProgressCount.textContent = `${processed}/${newFiles.length}`;
      }

      // Show summary
      if (scanCancelled) {
        showStatus(`Scan cancelled: ${processed} processed — ${scanAutoMoved} auto-moved, ${scanNeedReview} need review, ${scanSkipped} skipped`, "info");
      } else {
        const parts = [];
        if (scanAutoMoved > 0) parts.push(`${scanAutoMoved} auto-moved`);
        if (scanNeedReview > 0) parts.push(`${scanNeedReview} need review`);
        if (scanSkipped > 0) parts.push(`${scanSkipped} skipped`);
        showStatus(`Scan complete: ${parts.join(", ")}`, "success");
      }

      // Hide progress bar and reset state
      scanProgress.style.display = "none";
      scanInProgress = false;
      scanCancelled = false;
      scanFolderBtn.disabled = false;

    } catch (error) {
      showStatus(`Scan failed: ${error}`, "error");
      scanProgress.style.display = "none";
      scanInProgress = false;
      scanCancelled = false;
      scanFolderBtn.disabled = false;
    }
  }

  // Set up listener for tray hint (when window is minimized to tray)
  function setupTrayHintListener() {
    listen("tray-hint", (event) => {
      const message = event.payload;
      sendAppNotification("File Organizer", message);
      console.log("[APP] " + message);
    });
  }

  // Set up listener for file detection events from Rust
  function setupFileListener() {
    listen("file-detected", async (event) => {
      const fileInfo = event.payload;
      console.log("File detected:", fileInfo);
      fileInfo.timestamp = Date.now();
      sendAppNotification("New file detected", fileInfo.name);
      pendingBatch.push(fileInfo);

      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = setTimeout(() => processBatch(), BATCH_WINDOW_MS);

      if (pendingBatch.length === 1) {
        showStatus(`Detecting files... (${pendingBatch.length} file)`, "info");
      } else {
        showStatus(`Detecting files... (${pendingBatch.length} files)`, "info");
      }
    });
  }

  // Set up drag & drop on app window
  function setupDragAndDrop() {
    const dropOverlay = document.getElementById("drop-overlay");

    listen("tauri://drag-drop", async (event) => {
      dropOverlay.style.display = "none";
      document.body.classList.remove("drag-over");

      const paths = event.payload.paths || [];
      if (paths.length === 0) return;
      if (userModules.length === 0) {
        showStatus("Please add modules first in Settings", "error");
        return;
      }

      console.log(`[DRAG-DROP] ${paths.length} file(s) dropped`);

      for (const filePath of paths) {
        // Extract filename and get file size via scan_files on parent dir
        const name = pathBasename(filePath);
        const fileInfo = { name, path: filePath, size: 0, timestamp: Date.now() };

        // Skip if already tracked
        const alreadyTracked = detectedFiles.some(f => f.path === filePath)
          || skippedFiles.some(f => f.path === filePath)
          || ignoredFiles.some(f => f.path === filePath);
        if (alreadyTracked) {
          showStatus(`${name} is already tracked`, "info");
          continue;
        }

        showStatus(`Dropped: ${name}`, "success");
        await addDetectedFile(fileInfo);
      }
    });

    listen("tauri://drag-over", () => {
      dropOverlay.style.display = "flex";
      document.body.classList.add("drag-over");
    });

    listen("tauri://drag-leave", () => {
      dropOverlay.style.display = "none";
      document.body.classList.remove("drag-over");
    });
  }

  // Keyboard shortcuts for quick file actions
  function setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      // Don't trigger shortcuts when typing in inputs
      const tag = e.target.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      // Ctrl+Z: Undo last move (works even without a file card)
      if (e.ctrlKey && e.key === "z") {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Get the first (top) file card in the list
      const topCard = fileList.querySelector(".file-item");
      if (!topCard) return;

      // Number keys 1-9: Move to folder by index
      if (e.key >= "1" && e.key <= "9") {
        const folderSelect = topCard.querySelector(".folder-select");
        const index = parseInt(e.key); // 1-based (0 is "Choose destination...")
        if (folderSelect && index < folderSelect.options.length) {
          folderSelect.selectedIndex = index;
          const moveBtn = topCard.querySelector(".move-btn");
          if (moveBtn && !moveBtn.disabled) moveBtn.click();
        }
        return;
      }

      switch (e.key.toLowerCase()) {
        case "enter": {
          // Accept AI suggestion
          e.preventDefault();
          const acceptBtn = topCard.querySelector(".accept-btn");
          if (acceptBtn && !acceptBtn.disabled) {
            acceptBtn.click();
          }
          break;
        }
        case "a": {
          // Accept AI suggestion
          const acceptBtn = topCard.querySelector(".accept-btn");
          if (acceptBtn && !acceptBtn.disabled) {
            acceptBtn.click();
          }
          break;
        }
        case "escape": {
          // Dismiss / ignore
          const ignoreBtn = topCard.querySelector(".ignore-btn");
          if (ignoreBtn) {
            ignoreBtn.click();
          }
          break;
        }
        case "i": {
          // Ignore / dismiss
          const ignoreBtn = topCard.querySelector(".ignore-btn");
          if (ignoreBtn) {
            ignoreBtn.click();
          }
          break;
        }
        case "d": {
          // Delete (trash)
          const trashBtn = topCard.querySelector(".trash-btn");
          if (trashBtn && !trashBtn.disabled) {
            trashBtn.click();
          }
          break;
        }
        case "p": {
          // Preview toggle
          const previewBtn = topCard.querySelector(".preview-btn");
          if (previewBtn) {
            previewBtn.click();
          }
          break;
        }
      }
    });
  }

  // Process pending batch
  async function processBatch() {
    if (pendingBatch.length === 0) return;

    const batchSize = pendingBatch.length;
    const shouldBatch = shouldGroupAsBatch(pendingBatch);

    if (batchSize === 1 || !shouldBatch) {
      for (const fileInfo of pendingBatch) {
        showStatus(`New file detected: ${fileInfo.name}`, "success");
        await addDetectedFile(fileInfo);
      }
    } else {
      showStatus(`Batch detected: ${batchSize} files`, "success");
      const batchContainer = createBatchContainer(batchSize);
      for (const fileInfo of pendingBatch) {
        await addDetectedFileToBatch(fileInfo, batchContainer);
      }
    }

    pendingBatch = [];
    batchTimer = null;
  }

  // shouldGroupAsBatch is imported from utils.js

  // Create a batch container
  function createBatchContainer(batchSize) {
    const emptyMsg = fileList.querySelector(".empty-msg");
    if (emptyMsg) emptyMsg.remove();

    const batchId = `batch-${Date.now()}`;
    const batchContainer = document.createElement("div");
    batchContainer.className = "batch-container";
    batchContainer.setAttribute("data-batch-id", batchId);
    batchContainer.innerHTML = `
      <div class="batch-header">
        <h3>Batch Download</h3>
        <span class="batch-count">${batchSize} files</span>
      </div>
      <div class="batch-files"></div>
      <div class="batch-actions" style="margin-top: 10px; display: none;">
        <button class="batch-accept-btn" data-batch-id="${batchId}">
          Accept All High Confidence in This Batch (<span class="batch-high-count">0</span>)
        </button>
      </div>
    `;

    // Bind batch accept button
    batchContainer.querySelector(".batch-accept-btn").addEventListener("click", function() {
      acceptBatchHighConfidence(this.getAttribute("data-batch-id"));
    });

    fileList.insertBefore(batchContainer, fileList.firstChild);
    return batchContainer.querySelector(".batch-files");
  }

  // File type helpers and CONFIDENCE_THRESHOLD imported from utils.js / constants.js

  // Classification pipeline: Rules → Cache → API (two-pass)
  async function invokeClassify(fileInfo, statusCallback) {
    // Check user-defined rules first (instant, no API call)
    const ruleResult = matchRule(fileInfo.name, classificationRules);
    if (ruleResult) {
      console.log(`[RULES] ${fileInfo.name} matched rule → ${ruleResult.suggested_folder}`);
      return ruleResult;
    }

    // Check cache: reuse result if we've seen this exact filename before
    const cached = getCachedClassification(fileInfo.name, correctionLog, userModules, basePath);
    if (cached) {
      console.log(`[CACHE] ${fileInfo.name} → ${cached.suggested_folder}`);
      return cached;
    }

    const availableFolders = getAvailableFolders();
    const correctionHistory = buildCorrectionHistory(correctionLog);

    // Pass 1: Filename-based classification
    if (statusCallback) statusCallback("Analyzing filename...");
    const firstPass = await invoke("classify_file", {
      filename: fileInfo.name,
      availableFolders: availableFolders,
      correctionHistory: correctionHistory,
    });

    console.log(`[PASS 1] ${fileInfo.name}: confidence=${firstPass.confidence}, relevant=${firstPass.is_relevant}, folder="${firstPass.suggested_folder}"`);

    // Pass 2: Content-based fallback for low-confidence results
    const canUseVision = isImageFile(fileInfo.name);
    const canExtractText = isContentExtractable(fileInfo.name);

    // For image files, ALWAYS use vision if filename is ambiguous (screenshots, generic names)
    // because the filename alone can't determine if a screenshot contains academic content
    if (canUseVision && firstPass.confidence < CONFIDENCE_THRESHOLD) {
      // Skip the short-circuit — go straight to vision pass below
    } else if (canExtractText) {
      // Skip the short-circuit — ALWAYS extract content for PDFs/text files
      // Filenames like "PS1_sol.pdf" are too generic; actual content is far more reliable
    } else if (firstPass.confidence >= CONFIDENCE_THRESHOLD || (!firstPass.is_relevant && firstPass.confidence === 0)) {
      // High confidence or clearly not relevant (and not an image/pdf) — use first pass
      return firstPass;
    }

    if (canUseVision) {
      // Try OCR first (free, local) — fall back to vision API if OCR gets too little text
      console.log(`[PASS 2] Low confidence (${firstPass.confidence}), trying OCR for: ${fileInfo.name}`);
      if (statusCallback) statusCallback("Filename unclear - extracting text from image (OCR)...");
      try {
        return await invoke("classify_image_with_ocr", {
          filePath: fileInfo.path,
          filename: fileInfo.name,
          availableFolders: availableFolders,
          correctionHistory: correctionHistory,
        });
      } catch (ocrError) {
        const errMsg = typeof ocrError === "string" ? ocrError : (ocrError?.message || String(ocrError));
        if (errMsg.includes("OCR_INSUFFICIENT_TEXT")) {
          console.log(`[PASS 2] OCR extracted too little text, falling back to vision for: ${fileInfo.name}`);
        } else {
          console.warn(`[PASS 2] OCR failed (${errMsg}), falling back to vision for: ${fileInfo.name}`);
        }
        // Fall back to GPT-4o vision
        if (statusCallback) statusCallback("OCR insufficient - analyzing with AI vision...");
        try {
          return await invoke("classify_image_file", {
            filePath: fileInfo.path,
            filename: fileInfo.name,
            availableFolders: availableFolders,
            correctionHistory: correctionHistory,
          });
        } catch (visionError) {
          console.error("[PASS 2] Vision fallback also failed, using pass 1 result:", visionError);
          return firstPass;
        }
      }
    }

    if (canExtractText) {
      console.log(`[PASS 2] Extracting content for: ${fileInfo.name} (filename confidence: ${firstPass.confidence}, but content is more reliable)`);
      if (statusCallback) statusCallback("Filename unclear - reading file content for better classification...");
      try {
        return await invoke("classify_with_content", {
          filePath: fileInfo.path,
          filename: fileInfo.name,
          availableFolders: availableFolders,
          correctionHistory: correctionHistory,
        });
      } catch (e) {
        console.error("[PASS 2] Content extraction fallback failed, using pass 1 result:", e);
        return firstPass;
      }
    }

    // No content fallback available, return first pass as-is
    return firstPass;
  }

  // Classify and render a file item (shared logic)
  // Returns true if file is relevant (shown in UI), false if skipped
  async function classifyAndRender(fileInfo, fileItem) {
    try {
      const loadingDiv = fileItem.querySelector(".ai-loading");
      const classification = await invokeClassify(fileInfo, (msg) => {
        if (loadingDiv) loadingDiv.textContent = msg;
      });

      // Normalize suggested_folder: GPT sometimes returns just the folder name
      // (e.g. "Machine Learning") instead of the full path. Match it against
      // available folders to get the correct absolute path.
      if (classification.suggested_folder &&
          classification.suggested_folder !== "__UNSORTED__" &&
          classification.is_relevant) {
        const availableFolders = getAvailableFolders();
        const sf = classification.suggested_folder;
        // Already a full path that matches an available folder — keep as-is
        if (!availableFolders.includes(sf)) {
          // Try to match by folder name (last path segment)
          const sfName = pathBasename(sf);
          const match = availableFolders.find(f => {
            const fName = pathBasename(f);
            return fName.toLowerCase() === sfName.toLowerCase();
          });
          if (match) {
            console.log(`[NORMALIZE] "${sf}" → "${match}"`);
            classification.suggested_folder = match;
          } else {
            console.warn(`[NORMALIZE] Could not match "${sf}" to any available folder`);
          }
        }
      }

      // Two-stage: check if file is educational
      if (!classification.is_relevant) {
        // Not coursework - silently skip, remove from main UI
        const index = detectedFiles.findIndex(f => f.path === fileInfo.path);
        if (index > -1) detectedFiles.splice(index, 1);
        fileCount.textContent = detectedFiles.length;

        fileItem.style.opacity = "0";
        setTimeout(() => {
          fileItem.remove();
          if (detectedFiles.length === 0) {
            fileList.innerHTML = '<p class="empty-msg">No files detected yet. Drop a file in your watched folder to test!</p>';
          }
        }, 200);

        // Add to skipped list
        addToSkippedList(fileInfo, classification.reasoning);
        return false;
      }

      // Auto-move: if enabled and confidence meets threshold, move automatically
      // Skip auto-move for unsorted files (no matching module)
      if (autoMoveEnabled && classification.is_relevant &&
          classification.confidence >= autoMoveThreshold &&
          classification.suggested_folder &&
          classification.suggested_folder !== "__UNSORTED__") {
        const suggestedModuleName = pathBasename(classification.suggested_folder);
        console.log(`[AUTO-MOVE] ${fileInfo.name} → ${suggestedModuleName} (${Math.round(classification.confidence * 100)}%)`);

        try {
          await moveWithAutoRename(fileInfo.path, classification.suggested_folder);

          const filename = fileInfo.name;
          const moduleName = suggestedModuleName;
          logCorrection(filename, moduleName, moduleName, "accepted");

          const movedDestPath = pathJoin(classification.suggested_folder, filename);
          addActivityEntry(filename, watchPath, classification.suggested_folder);
          renderActivityLog();
          showUndoToast(filename, movedDestPath, watchPath);

          removeFileFromUI(fileInfo.path, fileItem);
          sendAppNotification("File auto-organized", `${filename} → ${moduleName}`);
          showStatus(`Auto-moved: ${filename} → ${moduleName}`, "success");
          return true;
        } catch (error) {
          console.error("[AUTO-MOVE] Failed, falling back to manual:", error);
          // Fall through to show the card normally
        }
      }

      // File is educational - show classification
      const suggestionDiv = fileItem.querySelector(".ai-suggestion");
      const confidencePercent = Math.round(classification.confidence * 100);
      const confidenceClass = classification.confidence > 0.8 ? "high" : classification.confidence > 0.5 ? "medium" : "low";

      const isUnsorted = classification.suggested_folder === "__UNSORTED__";

      if (isUnsorted) {
        // File is educational but doesn't match any configured module
        suggestionDiv.innerHTML = `
          <div class="ai-result low">
            <strong>No matching module</strong>
            <span class="confidence">Educational but doesn't fit current modules</span>
            <button class="create-module-btn">+ Create Module</button>
          </div>
          <div class="ai-reasoning">${escapeHtml(classification.reasoning)}</div>
        `;
        // Wire up create module button
        suggestionDiv.querySelector(".create-module-btn").addEventListener("click", () => {
          quickCreateModule(fileInfo, fileItem, classification);
        });
        // Don't pre-select any folder — user must pick manually or ignore
        const folderSelect = fileItem.querySelector(".folder-select");
        folderSelect.value = "";
      } else {
        const suggestedModuleName = pathBasename(classification.suggested_folder);

        const hasSuggestedRename = classification.suggested_filename &&
          classification.suggested_filename !== fileInfo.name;

        suggestionDiv.innerHTML = `
          <div class="ai-result ${confidenceClass}">
            <strong>AI Suggests:</strong> ${escapeHtml(suggestedModuleName)}
            <span class="confidence">${confidencePercent}% confident</span>
            <button class="accept-btn">Accept</button>
          </div>
          ${hasSuggestedRename ? `
          <div class="ai-rename-suggestion">
            <span>Rename:</span>
            <input type="text" class="rename-input" value="${escapeHtml(classification.suggested_filename)}" readonly />
            <button class="edit-rename-btn" title="Edit filename">&#9998;</button>
            <button class="accept-rename-btn">Accept &amp; Rename</button>
          </div>
          ` : ""}
          <div class="ai-reasoning">${escapeHtml(classification.reasoning)}</div>
        `;

        suggestionDiv.querySelector(".accept-btn").addEventListener("click", function() {
          acceptAISuggestion(fileInfo.path, classification.suggested_folder, this);
        });

        if (hasSuggestedRename) {
          const renameInput = suggestionDiv.querySelector(".rename-input");
          const editBtn = suggestionDiv.querySelector(".edit-rename-btn");
          const acceptRenameBtn = suggestionDiv.querySelector(".accept-rename-btn");

          editBtn.addEventListener("click", () => {
            renameInput.removeAttribute("readonly");
            renameInput.focus();
            // Select text before extension
            const dotIndex = renameInput.value.lastIndexOf(".");
            renameInput.setSelectionRange(0, dotIndex > 0 ? dotIndex : renameInput.value.length);
          });

          acceptRenameBtn.addEventListener("click", function() {
            acceptAISuggestionWithRename(
              fileInfo.path, classification.suggested_folder,
              renameInput.value.trim(), this
            );
          });
        }

        const folderSelect = fileItem.querySelector(".folder-select");
        folderSelect.value = classification.suggested_folder;
      }

      // Add folder quick-action chips below the suggestion
      const chipsDiv = document.createElement("div");
      chipsDiv.className = "folder-chips";
      chipsDiv.innerHTML = userModules.map((name, i) => {
        const fullPath = pathJoin(basePath, name);
        const isSelected = fullPath === classification.suggested_folder;
        return `<button class="folder-chip ${isSelected ? "selected" : ""}"
                  data-folder="${escapeHtml(fullPath)}" title="Press ${i + 1} to move here">
                  ${escapeHtml(name)}
                </button>`;
      }).join("");
      suggestionDiv.appendChild(chipsDiv);
      chipsDiv.querySelectorAll(".folder-chip").forEach(chip => {
        chip.addEventListener("click", function() {
          acceptAISuggestion(fileInfo.path, this.getAttribute("data-folder"), this);
        });
      });

      const fileIndex = detectedFiles.findIndex(f => f.path === fileInfo.path);
      if (fileIndex > -1) {
        detectedFiles[fileIndex].classification = classification;
        detectedFiles[fileIndex].isHighConfidence = classification.confidence > 0.8 && !isUnsorted;
      }

      if (classification.confidence > 0.8 && !isUnsorted) {
        fileItem.setAttribute("data-high-confidence", "true");
        fileItem.setAttribute("data-suggested-folder", classification.suggested_folder);
      }

      updateBatchActions();
      return true;
    } catch (error) {
      console.error("AI classification failed:", error);
      const suggestionDiv = fileItem.querySelector(".ai-suggestion");
      suggestionDiv.innerHTML = `<div class="ai-error">AI classification failed: ${escapeHtml(String(error))}</div>`;
      return true; // Keep in UI on error so user can manually classify
    }
  }

  // Add a file to the skipped (non-educational) list
  function addToSkippedList(fileInfo, reasoning) {
    skippedFiles.push({ name: fileInfo.name, path: fileInfo.path, size: fileInfo.size, reasoning });

    // Show skipped section
    skippedSection.style.display = "block";
    skippedCountEl.textContent = skippedFiles.length;

    // Add to expandable list
    const skippedItem = document.createElement("div");
    skippedItem.className = "skipped-item";
    skippedItem.innerHTML = `
      <div class="skipped-file-info">
        <strong>${escapeHtml(fileInfo.name)}</strong>
        <small>${formatFileSize(fileInfo.size)}</small>
      </div>
      <div class="skipped-reasoning">${escapeHtml(reasoning)}</div>
      <button class="rescue-btn">Classify anyway</button>
    `;

    skippedItem.querySelector(".rescue-btn").addEventListener("click", async function() {
      // Remove from skipped
      const idx = skippedFiles.findIndex(f => f.path === fileInfo.path);
      if (idx > -1) skippedFiles.splice(idx, 1);
      skippedCountEl.textContent = skippedFiles.length;
      if (skippedFiles.length === 0) skippedSection.style.display = "none";

      skippedItem.remove();

      // Re-add to main file list as a regular detected file (force relevant)
      await addDetectedFileForceRelevant(fileInfo);
    });

    skippedList.appendChild(skippedItem);
  }

  // Add a rescued file to the main list, skip the relevance check
  async function addDetectedFileForceRelevant(fileInfo) {
    detectedFiles.push(fileInfo);
    fileCount.textContent = detectedFiles.length;

    const emptyMsg = fileList.querySelector(".empty-msg");
    if (emptyMsg) emptyMsg.remove();

    const fileItem = createFileItemElement(fileInfo, null);
    fileList.insertBefore(fileItem, fileList.firstChild);

    // Classify but force-show regardless of is_relevant
    try {
      const loadingDiv = fileItem.querySelector(".ai-loading");
      const classification = await invokeClassify(fileInfo, (msg) => {
        if (loadingDiv) loadingDiv.textContent = msg;
      });

      const suggestionDiv = fileItem.querySelector(".ai-suggestion");
      const confidencePercent = Math.round(classification.confidence * 100);
      const confidenceClass = classification.confidence > 0.8 ? "high" : classification.confidence > 0.5 ? "medium" : "low";
      const suggestedModuleName = pathBasename(classification.suggested_folder) || "Unknown";

      if (classification.suggested_folder) {
        suggestionDiv.innerHTML = `
          <div class="ai-result ${confidenceClass}">
            <strong>AI Suggests:</strong> ${escapeHtml(suggestedModuleName)}
            <span class="confidence">${confidencePercent}% confident</span>
            <button class="accept-btn">Accept</button>
          </div>
          <div class="ai-reasoning">${escapeHtml(classification.reasoning)}</div>
        `;
        suggestionDiv.querySelector(".accept-btn").addEventListener("click", function() {
          acceptAISuggestion(fileInfo.path, classification.suggested_folder, this);
        });
        const folderSelect = fileItem.querySelector(".folder-select");
        folderSelect.value = classification.suggested_folder;
      } else {
        suggestionDiv.innerHTML = `<div class="ai-loading">AI couldn't suggest a folder - please choose manually</div>`;
      }
    } catch (error) {
      const suggestionDiv = fileItem.querySelector(".ai-suggestion");
      suggestionDiv.innerHTML = `<div class="ai-error">AI classification failed: ${escapeHtml(String(error))}</div>`;
    }

    showStatus(`Rescued: ${fileInfo.name}`, "success");
  }

  // Create a file item element
  function createFileItemElement(fileInfo, batchId) {
    const fileItem = document.createElement("div");
    fileItem.className = "file-item";
    fileItem.setAttribute("data-file-path", fileInfo.path);
    if (batchId) fileItem.setAttribute("data-batch-id", batchId);

    fileItem.innerHTML = `
      <div class="file-header">
        <div class="file-info">
          <span class="file-type-icon">${getFileTypeIcon(fileInfo.name)}</span>
          <strong class="file-name-display">${escapeHtml(fileInfo.name)}</strong>
          <button class="rename-btn" title="Rename file" aria-label="Rename file">&#9998;</button>
          <small>${formatFileSize(fileInfo.size)}</small>
        </div>
        <button class="dismiss-btn" title="Dismiss - don't organize this file" aria-label="Dismiss file">&times;</button>
      </div>
      <div class="file-rename-input" style="display: none;">
        <input type="text" class="rename-input" value="${escapeHtml(fileInfo.name)}" />
        <button class="rename-confirm-btn">Save</button>
        <button class="rename-cancel-btn">Cancel</button>
      </div>
      <div class="file-path">
        <span>${escapeHtml(fileInfo.path)}</span>
      </div>
      <div class="file-preview-toggle">
        <button class="preview-btn">Preview</button>
      </div>
      <div class="file-preview" style="display: none;"></div>
      <div class="ai-suggestion">
        <div class="ai-loading">Analyzing with AI...</div>
      </div>
      <div class="file-actions">
        <select class="folder-select">
          ${buildFolderOptions()}
        </select>
        <button class="move-btn">Move</button>
        <button class="ignore-btn">Ignore</button>
        <button class="trash-btn" title="Send to recycle bin">Delete</button>
      </div>
    `;

    // Bind move button
    fileItem.querySelector(".move-btn").addEventListener("click", function() {
      moveFile(fileInfo.path, this);
    });

    // Bind ignore button
    fileItem.querySelector(".ignore-btn").addEventListener("click", function() {
      dismissFile(fileInfo, fileItem);
    });

    // Bind dismiss button
    fileItem.querySelector(".dismiss-btn").addEventListener("click", function() {
      dismissFile(fileInfo, fileItem);
    });

    // Bind trash (delete) button
    fileItem.querySelector(".trash-btn").addEventListener("click", async function() {
      if (!confirm(`Send "${fileInfo.name}" to Recycle Bin?`)) return;
      this.disabled = true;
      this.textContent = "Deleting...";
      try {
        await invoke("trash_file", { filePath: fileInfo.path });
        removeFileFromUI(fileInfo.path, fileItem);
        showStatus(`Deleted: ${fileInfo.name} (sent to Recycle Bin)`, "success");
      } catch (error) {
        showStatus(`Delete failed: ${error}`, "error");
        this.disabled = false;
        this.textContent = "Delete";
      }
    });

    // Bind rename button
    const renameBtn = fileItem.querySelector(".rename-btn");
    const renameInputDiv = fileItem.querySelector(".file-rename-input");
    const renameInput = fileItem.querySelector(".rename-input");
    const renameConfirmBtn = fileItem.querySelector(".rename-confirm-btn");
    const renameCancelBtn = fileItem.querySelector(".rename-cancel-btn");
    const fileNameDisplay = fileItem.querySelector(".file-name-display");

    renameBtn.addEventListener("click", () => {
      renameInputDiv.style.display = "flex";
      renameInput.value = fileInfo.name;
      renameInput.focus();
      renameInput.setSelectionRange(0, fileInfo.name.lastIndexOf(".") > 0 ? fileInfo.name.lastIndexOf(".") : fileInfo.name.length);
    });

    renameCancelBtn.addEventListener("click", () => {
      renameInputDiv.style.display = "none";
    });

    const doRename = async () => {
      const newName = renameInput.value.trim();
      if (!newName || newName === fileInfo.name) {
        renameInputDiv.style.display = "none";
        return;
      }
      try {
        const newPath = await invoke("rename_file", { filePath: fileInfo.path, newName });
        // Update fileInfo in place
        const oldName = fileInfo.name;
        fileInfo.name = newName;
        fileInfo.path = newPath;
        fileNameDisplay.textContent = newName;
        fileItem.querySelector(".file-path span").textContent = newPath;
        fileItem.setAttribute("data-file-path", newPath);
        // Update in detectedFiles array
        const idx = detectedFiles.findIndex(f => f.path === fileInfo.path || f.name === oldName);
        if (idx > -1) {
          detectedFiles[idx].name = newName;
          detectedFiles[idx].path = newPath;
        }
        renameInputDiv.style.display = "none";
        showStatus(`Renamed to: ${newName}`, "success");
      } catch (error) {
        showStatus(`Rename failed: ${error}`, "error");
      }
    };

    renameConfirmBtn.addEventListener("click", doRename);
    renameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doRename();
      if (e.key === "Escape") renameInputDiv.style.display = "none";
    });

    // Bind preview button (lazy-load on first click)
    const previewBtn = fileItem.querySelector(".preview-btn");
    const previewDiv = fileItem.querySelector(".file-preview");
    let previewLoaded = false;
    previewBtn.addEventListener("click", async () => {
      if (previewDiv.style.display !== "none") {
        previewDiv.style.display = "none";
        previewBtn.textContent = "Preview";
        return;
      }
      previewDiv.style.display = "block";
      previewBtn.textContent = "Hide";

      if (previewLoaded) return;
      previewLoaded = true;
      previewDiv.innerHTML = '<div class="preview-loading">Loading preview...</div>';

      try {
        const preview = await invoke("get_file_preview", { filePath: fileInfo.path });
        if (preview.error) {
          previewDiv.innerHTML = `<div class="preview-error">${escapeHtml(preview.error)}</div>`;
        } else if (preview.preview_type === "image") {
          previewDiv.innerHTML = `<img class="preview-image" src="${preview.content}" alt="Preview" />`;
        } else if (preview.preview_type === "text" && preview.content) {
          previewDiv.innerHTML = `<pre class="preview-text">${escapeHtml(preview.content)}</pre>`;
        } else {
          previewDiv.innerHTML = '<div class="preview-error">No preview available</div>';
        }
      } catch (e) {
        previewDiv.innerHTML = `<div class="preview-error">Preview failed</div>`;
      }
    });

    return fileItem;
  }

  // Add a detected file to batch container
  async function addDetectedFileToBatch(fileInfo, batchFilesContainer) {
    detectedFiles.push(fileInfo);
    fileCount.textContent = detectedFiles.length;

    const batchContainer = batchFilesContainer.closest(".batch-container");
    const batchId = batchContainer.getAttribute("data-batch-id");

    const fileItem = createFileItemElement(fileInfo, batchId);
    batchFilesContainer.appendChild(fileItem);

    await classifyAndRender(fileInfo, fileItem);
  }

  // Add a detected file individually
  async function addDetectedFile(fileInfo) {
    detectedFiles.push(fileInfo);
    fileCount.textContent = detectedFiles.length;

    const emptyMsg = fileList.querySelector(".empty-msg");
    if (emptyMsg) emptyMsg.remove();

    const fileItem = createFileItemElement(fileInfo, null);
    fileList.insertBefore(fileItem, fileList.firstChild);

    showStatus(`New file detected: ${fileInfo.name}`, "success");
    await classifyAndRender(fileInfo, fileItem);
  }

  // Dismiss a file - remove from queue without moving, log the correction, show in ignored section
  function dismissFile(fileInfo, fileItem) {
    // Log as dismissed so AI learns this type of file isn't worth suggesting
    const fileData = detectedFiles.find(f => f.path === fileInfo.path);
    const aiSuggested = pathBasename(fileData?.classification?.suggested_folder || "") || "unknown";
    logCorrection(fileInfo.name, aiSuggested, "dismissed", "dismissed");

    removeFileFromUI(fileInfo.path, fileItem);
    addToIgnoredList(fileInfo);
    renderStats();
    showStatus(`Ignored: ${fileInfo.name}`, "info");
  }

  // Add a file to the ignored (user-dismissed) list
  function addToIgnoredList(fileInfo) {
    ignoredFiles.push({ name: fileInfo.name, path: fileInfo.path, size: fileInfo.size });

    ignoredSection.style.display = "block";
    ignoredCountEl.textContent = ignoredFiles.length;

    const ignoredItem = document.createElement("div");
    ignoredItem.className = "skipped-item";
    ignoredItem.innerHTML = `
      <div class="skipped-file-info">
        <strong>${escapeHtml(fileInfo.name)}</strong>
        <small>${formatFileSize(fileInfo.size)}</small>
      </div>
      <button class="rescue-btn">Reconsider</button>
    `;

    ignoredItem.querySelector(".rescue-btn").addEventListener("click", async function() {
      const idx = ignoredFiles.findIndex(f => f.path === fileInfo.path);
      if (idx > -1) ignoredFiles.splice(idx, 1);
      ignoredCountEl.textContent = ignoredFiles.length;
      if (ignoredFiles.length === 0) ignoredSection.style.display = "none";

      ignoredItem.remove();
      await addDetectedFileForceRelevant(fileInfo);
    });

    ignoredList.appendChild(ignoredItem);
  }

  // Move a file to selected destination
  async function moveFile(filePath, buttonElement) {
    const fileItem = buttonElement.closest(".file-item");
    const folderSelect = fileItem.querySelector(".folder-select");
    const destFolder = folderSelect.value;

    if (!destFolder) {
      showStatus("Please select a destination folder first", "error");
      return;
    }

    buttonElement.disabled = true;
    buttonElement.textContent = "Moving...";

    // Get the file info for correction logging
    const fileData = detectedFiles.find(f => f.path === filePath);
    const filename = fileData?.name || pathBasename(filePath);
    const aiSuggested = fileData?.classification?.suggested_folder || "";
    const destModuleName = pathBasename(destFolder);
    const aiModuleName = pathBasename(aiSuggested);

    try {
      const moveResult = await moveWithDuplicateCheck(filePath, destFolder, fileData);
      if (!moveResult.success) {
        buttonElement.disabled = false;
        buttonElement.textContent = "Move";
        if (moveResult.skipped) showStatus("Move skipped", "info");
        return;
      }

      // Log correction: did user agree with AI or pick a different folder?
      if (aiSuggested && destFolder === aiSuggested) {
        logCorrection(filename, aiModuleName, destModuleName, "accepted");
      } else if (aiSuggested) {
        logCorrection(filename, aiModuleName, destModuleName, "corrected");
      }

      // Build the full destination path for undo
      const movedDestPath = pathJoin(destFolder, filename);
      addActivityEntry(filename, watchPath, destFolder);
      renderActivityLog();
      showUndoToast(filename, movedDestPath, watchPath);

      removeFileFromUI(filePath, fileItem);
      sendAppNotification("File moved", `${filename} → ${destModuleName}`);
      const statusText = moveResult.renamed ? `${moveResult.result} (kept both)` : moveResult.result;
      showStatus(statusText, "success");
    } catch (error) {
      console.error("[MOVE] Error moving file:", typeof error, JSON.stringify(error), error);
      if (isLockedFileError(error)) {
        buttonElement.textContent = "Waiting...";
        showStatus("File is in use - will auto-move when available", "info");
        retryMoveFile(filePath, destFolder, fileItem, 0, async () => {
          if (aiSuggested && destFolder === aiSuggested) {
            await logCorrection(filename, aiModuleName, destModuleName, "accepted");
          } else if (aiSuggested) {
            await logCorrection(filename, aiModuleName, destModuleName, "corrected");
          }
          const movedDestPath = pathJoin(destFolder, filename);
          await addActivityEntry(filename, watchPath, destFolder);
          renderActivityLog();
          showUndoToast(filename, movedDestPath, watchPath);
        });
      } else {
        showStatus(`Failed to move file: ${getErrorMessage(error)}`, "error");
        buttonElement.disabled = false;
        buttonElement.textContent = "Move";
      }
    }
  }

  // Accept AI suggestion
  async function acceptAISuggestion(filePath, suggestedFolder, buttonElement) {
    buttonElement.disabled = true;
    buttonElement.textContent = "Moving...";

    const fileItem = buttonElement.closest(".file-item");
    const fileData = detectedFiles.find(f => f.path === filePath);
    const filename = fileData?.name || pathBasename(filePath);
    const moduleName = pathBasename(suggestedFolder);

    try {
      const moveResult = await moveWithDuplicateCheck(filePath, suggestedFolder, fileData);
      if (!moveResult.success) {
        buttonElement.disabled = false;
        buttonElement.textContent = "Accept";
        if (moveResult.skipped) showStatus("Move skipped", "info");
        return;
      }

      // Log as accepted - AI got it right
      logCorrection(filename, moduleName, moduleName, "accepted");

      // Activity log and undo
      const movedDestPath = pathJoin(suggestedFolder, filename);
      addActivityEntry(filename, watchPath, suggestedFolder);
      renderActivityLog();
      showUndoToast(filename, movedDestPath, watchPath);

      removeFileFromUI(filePath, fileItem);
      const statusText = moveResult.renamed ? `${moveResult.result} (kept both)` : `${moveResult.result} (AI suggestion accepted)`;
      showStatus(statusText, "success");
    } catch (error) {
      console.error("[ACCEPT] Error accepting file:", typeof error, JSON.stringify(error), error);
      if (isLockedFileError(error)) {
        buttonElement.textContent = "Waiting...";
        showStatus("File is in use - will auto-move when available", "info");
        retryMoveFile(filePath, suggestedFolder, fileItem, 0, async (result) => {
          await logCorrection(filename, moduleName, moduleName, "accepted");
          const movedDestPath = pathJoin(suggestedFolder, filename);
          await addActivityEntry(filename, watchPath, suggestedFolder);
          renderActivityLog();
          showUndoToast(filename, movedDestPath, watchPath);
        });
      } else {
        showStatus(`Failed to move file: ${getErrorMessage(error)}`, "error");
        buttonElement.disabled = false;
        buttonElement.textContent = "Accept";
      }
    }
  }

  // Accept AI suggestion with rename — renames file and moves to suggested folder
  async function acceptAISuggestionWithRename(filePath, suggestedFolder, newName, buttonElement) {
    if (!newName || !newName.trim()) {
      showStatus("Filename cannot be empty", "error");
      return;
    }

    buttonElement.disabled = true;
    buttonElement.textContent = "Renaming...";

    const fileItem = buttonElement.closest(".file-item");
    const fileData = detectedFiles.find(f => f.path === filePath);
    const originalFilename = fileData?.name || pathBasename(filePath);
    const moduleName = pathBasename(suggestedFolder);

    // If name hasn't changed, fall through to regular accept
    if (newName === originalFilename) {
      const acceptBtn = fileItem.querySelector(".accept-btn");
      buttonElement.disabled = false;
      buttonElement.textContent = "Accept & Rename";
      acceptAISuggestion(filePath, suggestedFolder, acceptBtn);
      return;
    }

    try {
      await invoke("rename_and_move_file", {
        filePath,
        newName,
        destFolder: suggestedFolder,
      });

      logCorrection(originalFilename, moduleName, moduleName, "accepted");

      const movedDestPath = pathJoin(suggestedFolder, newName);
      addActivityEntry(newName, watchPath, suggestedFolder, originalFilename);
      renderActivityLog();
      showUndoToast(newName, movedDestPath, watchPath, originalFilename);

      removeFileFromUI(filePath, fileItem);
      showStatus(`Renamed & moved: ${originalFilename} → ${newName} → ${moduleName}`, "success");
    } catch (error) {
      console.error("[RENAME-MOVE] Error:", error);
      if (isLockedFileError(error)) {
        showStatus("File is in use — close it and try again", "error");
      } else if (isDuplicateError(error)) {
        showStatus(`A file named "${newName}" already exists in ${moduleName}`, "error");
      } else {
        showStatus(`Failed: ${getErrorMessage(error)}`, "error");
      }
      buttonElement.disabled = false;
      buttonElement.textContent = "Accept & Rename";
    }
  }

  // Remove file from UI after successful move
  function removeFileFromUI(filePath, fileItem) {
    const index = detectedFiles.findIndex(f => f.path === filePath);
    if (index > -1) detectedFiles.splice(index, 1);

    fileCount.textContent = detectedFiles.length;
    updateBatchActions();

    fileItem.style.opacity = "0";
    setTimeout(() => {
      fileItem.remove();
      if (detectedFiles.length === 0) {
        fileList.innerHTML = '<p class="empty-msg">No files detected yet. Drop a file in your watched folder to test!</p>';
      }
    }, FILE_REMOVE_ANIMATION_MS);
  }

  // Retry with exponential backoff then patient waiting
  // onSuccess is an optional callback called after a successful move (before removing from UI)
  async function retryMoveFile(filePath, destFolder, fileItemElement, retryCount, onSuccess) {
    const quickRetries = QUICK_RETRY_COUNT;
    const quickDelays = QUICK_RETRY_DELAYS;
    const patientDelay = PATIENT_RETRY_DELAY_MS;

    const suggestionDiv = fileItemElement.querySelector(".ai-suggestion");
    let delay;

    if (retryCount < quickRetries) {
      delay = quickDelays[retryCount];
      const nextRetry = retryCount + 1;
      if (suggestionDiv) {
        suggestionDiv.innerHTML = `<div class="ai-loading">File is in use. Retrying in ${delay / 1000}s... (Quick attempt ${nextRetry}/${quickRetries})</div>`;
      }
    } else {
      delay = patientDelay;
      const patientAttempt = retryCount - quickRetries + 1;
      fileItemElement.classList.add("patient-waiting");
      if (suggestionDiv) {
        suggestionDiv.innerHTML = `<div class="ai-loading">Waiting for file to be available... (Will check again in ${Math.round(delay / 60000)} min)<br><small>Patient retry #${patientAttempt}</small></div>`;
      }
    }

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      const result = await moveWithAutoRename(filePath, destFolder);

      if (onSuccess) await onSuccess(result);
      removeFileFromUI(filePath, fileItemElement);
      showStatus(`${result} (moved after ${retryCount + 1} retries)`, "success");
    } catch (error) {
      if (isLockedFileError(error)) {
        retryMoveFile(filePath, destFolder, fileItemElement, retryCount + 1, onSuccess);
      } else {
        if (suggestionDiv) {
          suggestionDiv.innerHTML = `<div class="ai-error">Failed to move: ${escapeHtml(String(error))}</div>`;
        }
        showStatus(`Failed to move file: ${getErrorMessage(error)}`, "error");
      }
    }
  }

  // Dismiss all detected files at once
  async function dismissAll() {
    if (detectedFiles.length === 0) {
      showStatus("No files to dismiss", "info");
      return;
    }

    const fileItems = document.querySelectorAll(".file-item");
    for (const item of fileItems) {
      const filePath = item.getAttribute("data-file-path");
      const fileData = detectedFiles.find(f => f.path === filePath);
      if (fileData) {
        addToIgnoredList(fileData);
        logCorrection(fileData.name, "", "dismissed", "dismissed");
      }
      item.remove();
    }

    detectedFiles = [];
    fileCount.textContent = "0";
    fileList.innerHTML = '<p class="empty-msg">No files detected yet. Drop a file in your watched folder to test!</p>';
    updateBatchActions();
    renderStats();
    showStatus("All files dismissed", "info");
  }

  // Update batch actions visibility
  function updateBatchActions() {
    const highConfidenceFiles = detectedFiles.filter(f => f.isHighConfidence);
    const count = highConfidenceFiles.length;

    if (detectedFiles.length >= 2) {
      batchActions.style.display = "flex";
      highConfidenceCount.textContent = count;
      acceptAllHighBtn.style.display = count > 0 ? "" : "none";
    } else {
      batchActions.style.display = "none";
    }

    // Update per-batch actions
    document.querySelectorAll(".batch-container").forEach(batchContainer => {
      const batchId = batchContainer.getAttribute("data-batch-id");
      const highInBatch = document.querySelectorAll(`.file-item[data-batch-id="${batchId}"][data-high-confidence="true"]`);
      const batchActionsDiv = batchContainer.querySelector(".batch-actions");
      const batchHighCount = batchContainer.querySelector(".batch-high-count");

      if (highInBatch.length > 0) {
        batchActionsDiv.style.display = "block";
        batchHighCount.textContent = highInBatch.length;
      } else {
        batchActionsDiv.style.display = "none";
      }
    });
  }

  // Accept all high-confidence files
  async function acceptAllHighConfidence() {
    const highConfidenceItems = document.querySelectorAll('.file-item[data-high-confidence="true"]');
    if (highConfidenceItems.length === 0) {
      showStatus("No high-confidence files to accept", "info");
      return;
    }

    acceptAllHighBtn.disabled = true;
    acceptAllHighBtn.textContent = `Processing ${highConfidenceItems.length} files...`;

    let successCount = 0;
    let failCount = 0;

    for (const fileItem of highConfidenceItems) {
      const filePath = fileItem.getAttribute("data-file-path");
      const suggestedFolder = fileItem.getAttribute("data-suggested-folder");

      try {
        await moveWithAutoRename(filePath, suggestedFolder);

        const index = detectedFiles.findIndex(f => f.path === filePath);
        const filename = index > -1 ? detectedFiles[index].name : pathBasename(filePath);
        if (index > -1) detectedFiles.splice(index, 1);

        await addActivityEntry(filename, watchPath, suggestedFolder);

        fileItem.style.opacity = "0";
        setTimeout(() => fileItem.remove(), FILE_REMOVE_ANIMATION_MS);
        successCount++;
      } catch (error) {
        console.error(`Failed to move ${filePath}:`, error);
        failCount++;
        if (isLockedFileError(error)) {
          const retryFilename = filename;
          retryMoveFile(filePath, suggestedFolder, fileItem, 0, async () => {
            await addActivityEntry(retryFilename, watchPath, suggestedFolder);
            renderActivityLog();
          });
        }
      }
    }

    setTimeout(() => {
      fileCount.textContent = detectedFiles.length;
      updateBatchActions();
      renderActivityLog();
      if (detectedFiles.length === 0) {
        fileList.innerHTML = '<p class="empty-msg">No files detected yet. Drop a file in your watched folder to test!</p>';
      }
      if (failCount === 0) {
        showStatus(`Successfully moved ${successCount} files`, "success");
      } else {
        showStatus(`Moved ${successCount} files, ${failCount} files in retry queue`, "info");
      }
      acceptAllHighBtn.disabled = false;
      acceptAllHighBtn.textContent = "Accept All High Confidence (0)";
    }, 400);
  }

  // Accept all high-confidence files in a specific batch
  async function acceptBatchHighConfidence(batchId) {
    const highConfidenceItems = document.querySelectorAll(`.file-item[data-batch-id="${batchId}"][data-high-confidence="true"]`);
    if (highConfidenceItems.length === 0) {
      showStatus("No high-confidence files in this batch", "info");
      return;
    }

    const batchContainer = document.querySelector(`.batch-container[data-batch-id="${batchId}"]`);
    const batchBtn = batchContainer.querySelector(".batch-accept-btn");
    batchBtn.disabled = true;
    batchBtn.textContent = `Processing ${highConfidenceItems.length} files...`;

    let successCount = 0;
    let failCount = 0;

    for (const fileItem of highConfidenceItems) {
      const filePath = fileItem.getAttribute("data-file-path");
      const suggestedFolder = fileItem.getAttribute("data-suggested-folder");

      try {
        await moveWithAutoRename(filePath, suggestedFolder);

        const index = detectedFiles.findIndex(f => f.path === filePath);
        const filename = index > -1 ? detectedFiles[index].name : pathBasename(filePath);
        if (index > -1) detectedFiles.splice(index, 1);

        await addActivityEntry(filename, watchPath, suggestedFolder);

        fileItem.style.opacity = "0";
        setTimeout(() => fileItem.remove(), FILE_REMOVE_ANIMATION_MS);
        successCount++;
      } catch (error) {
        console.error(`Failed to move ${filePath}:`, error);
        failCount++;
        if (isLockedFileError(error)) {
          const retryFilename = filename;
          retryMoveFile(filePath, suggestedFolder, fileItem, 0, async () => {
            await addActivityEntry(retryFilename, watchPath, suggestedFolder);
            renderActivityLog();
          });
        }
      }
    }

    setTimeout(() => {
      fileCount.textContent = detectedFiles.length;
      updateBatchActions();
      renderActivityLog();
      const remainingInBatch = batchContainer.querySelectorAll(".file-item").length;
      if (remainingInBatch === 0) {
        batchContainer.style.opacity = "0";
        setTimeout(() => batchContainer.remove(), FILE_REMOVE_ANIMATION_MS);
      }
      if (detectedFiles.length === 0) {
        fileList.innerHTML = '<p class="empty-msg">No files detected yet. Drop a file in your watched folder to test!</p>';
      }
      if (failCount === 0) {
        showStatus(`Batch: Successfully moved ${successCount} files`, "success");
      } else {
        showStatus(`Batch: Moved ${successCount} files, ${failCount} files in retry queue`, "info");
      }
      batchBtn.disabled = false;
      batchBtn.textContent = "Accept All High Confidence in This Batch (0)";
    }, 400);
  }

  // Show undo toast after a successful move
  function showUndoToast(filename, destPath, originalFolder, originalFilename = null) {
    // Cancel any existing undo timer
    cancelUndo();

    lastMove = { filename, destPath, originalFolder, originalFilename, timestamp: Date.now() };
    const msg = originalFilename && originalFilename !== filename
      ? `Renamed "${originalFilename}" → "${filename}" and moved`
      : `Moved "${filename}"`;
    undoToastMsg.textContent = msg;
    undoToast.style.display = "flex";

    let secondsLeft = UNDO_TIMEOUT_MS / 1000;
    undoCountdownEl.textContent = secondsLeft;
    undoProgress.style.width = "100%";

    undoCountdownInterval = setInterval(() => {
      secondsLeft--;
      undoCountdownEl.textContent = secondsLeft;
      const pct = (secondsLeft / (UNDO_TIMEOUT_MS / 1000)) * 100;
      undoProgress.style.width = pct + "%";
      if (secondsLeft <= 0) {
        cancelUndo();
      }
    }, 1000);

    undoTimer = setTimeout(() => {
      cancelUndo();
    }, UNDO_TIMEOUT_MS);
  }

  // Cancel undo and hide toast
  function cancelUndo() {
    if (undoTimer) clearTimeout(undoTimer);
    if (undoCountdownInterval) clearInterval(undoCountdownInterval);
    undoTimer = null;
    undoCountdownInterval = null;
    lastMove = null;
    undoToast.style.display = "none";
  }

  // Handle undo button click
  async function handleUndo() {
    if (!lastMove) return;

    const { filename, destPath, originalFolder, originalFilename, timestamp } = lastMove;
    cancelUndo();

    try {
      // Step 1: Move file back to original folder
      await invoke("undo_move", {
        filePath: destPath,
        originalFolder: originalFolder,
      });

      // Step 2: If it was renamed, restore the original filename
      if (originalFilename && originalFilename !== filename) {
        try {
          await invoke("rename_file", {
            filePath: pathJoin(originalFolder, filename),
            newName: originalFilename,
          });
        } catch (renameError) {
          console.error("[UNDO] Rename-back failed:", renameError);
          showStatus(`File moved back but rename failed: ${getErrorMessage(renameError)}`, "error");
          markActivityUndone(timestamp);
          renderActivityLog();
          return;
        }
      }

      markActivityUndone(timestamp);
      renderActivityLog();
      const undoMsg = originalFilename && originalFilename !== filename
        ? `Undo: "${originalFilename}" restored (name and location)`
        : `Undo: "${filename}" restored`;
      showStatus(undoMsg, "success");
    } catch (error) {
      showStatus(`Undo failed: ${getErrorMessage(error)}`, "error");
    }
  }

  // Render the activity log
  function renderActivityLog() {
    activityCount.textContent = activityLog.filter(e => !e.undone).length;

    if (activityLog.length === 0) {
      activityList.innerHTML = '<p class="empty-msg">No activity yet.</p>';
      clearActivityBtn.style.display = "none";
      renderStats();
      return;
    }

    clearActivityBtn.style.display = "block";
    activityList.innerHTML = "";

    // Show last 20 entries
    const toShow = activityLog.slice(0, 20);
    for (const entry of toShow) {
      const item = document.createElement("div");
      item.className = "activity-item" + (entry.undone ? " undone" : "");

      const time = new Date(entry.timestamp);
      const timeStr = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const dateStr = isToday(time) ? "Today" : time.toLocaleDateString([], { month: "short", day: "numeric" });

      const toName = pathBasename(entry.to);
      const wasRenamed = entry.originalFilename && entry.originalFilename !== entry.filename;

      item.innerHTML = `
        <span class="activity-time">${dateStr} ${timeStr}</span>
        <span class="activity-desc">${wasRenamed ? `${escapeHtml(entry.originalFilename)} → ${escapeHtml(entry.filename)}` : escapeHtml(entry.filename)} → <strong>${escapeHtml(toName)}</strong></span>
        ${wasRenamed ? '<span class="rename-badge">renamed</span>' : ""}
        ${entry.undone ? '<span class="activity-undone-badge">undone</span>' : ""}
        <button class="folder-link-btn" title="Open folder in Explorer" aria-label="Open folder in Explorer">&#128193;</button>
      `;
      item.querySelector(".folder-link-btn").addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await openPath(entry.to);
        } catch (err) {
          showStatus(`Failed to open folder: ${err}`, "error");
        }
      });
      activityList.appendChild(item);
    }

    if (activityLog.length > 20) {
      const more = document.createElement("p");
      more.className = "activity-more";
      more.textContent = `+ ${activityLog.length - 20} older entries`;
      activityList.appendChild(more);
    }

    renderStats();
  }

  // isToday is imported from utils.js

  // Render statistics dashboard
  function renderStats() {
    const statsSection = document.getElementById("stats-section");
    const statsGrid = document.getElementById("stats-grid");
    if (!statsSection || !statsGrid) return;

    const total = activityLog.filter(e => !e.undone).length;
    const accepted = correctionLog.filter(c => c.type === "accepted").length;
    const corrected = correctionLog.filter(c => c.type === "corrected").length;
    const dismissed = correctionLog.filter(c => c.type === "dismissed").length;
    const accuracy = (accepted + corrected) > 0
      ? Math.round((accepted / (accepted + corrected)) * 100) : 0;

    const folderCounts = {};
    for (const e of activityLog.filter(e => !e.undone)) {
      const name = pathBasename(e.to);
      folderCounts[name] = (folderCounts[name] || 0) + 1;
    }
    const topFolders = Object.entries(folderCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 5);

    statsGrid.innerHTML = `
      <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Files Organized</div></div>
      <div class="stat-card"><div class="stat-value">${accuracy}%</div><div class="stat-label">AI Accuracy</div></div>
      <div class="stat-card"><div class="stat-value">${accepted}</div><div class="stat-label">Accepted</div></div>
      <div class="stat-card"><div class="stat-value">${corrected}</div><div class="stat-label">Corrected</div></div>
      <div class="stat-card"><div class="stat-value">${dismissed}</div><div class="stat-label">Dismissed</div></div>
      ${topFolders.length ? `<div class="stat-card wide"><div class="stat-label">Top Folders</div>
        <div class="top-folders">${topFolders.map(([name, count]) =>
          `<span class="top-folder">${escapeHtml(name)} <small>(${count})</small></span>`
        ).join("")}</div></div>` : ""}
    `;
    statsSection.style.display = total > 0 || correctionLog.length > 0 ? "block" : "none";
  }

  // Show status message with dismiss button
  function showStatus(message, type = "info") {
    statusMsg.innerHTML = "";
    const textSpan = document.createElement("span");
    textSpan.textContent = message;
    const closeBtn = document.createElement("button");
    closeBtn.className = "status-close-btn";
    closeBtn.textContent = "\u00D7";
    closeBtn.title = "Dismiss";
    closeBtn.addEventListener("click", () => {
      statusMsg.innerHTML = "";
      statusMsg.className = "status-msg";
    });
    statusMsg.appendChild(textSpan);
    statusMsg.appendChild(closeBtn);
    statusMsg.className = `status-msg ${type}`;
    setTimeout(() => {
      if (textSpan.isConnected && textSpan.textContent === message) {
        statusMsg.innerHTML = "";
        statusMsg.className = "status-msg";
      }
    }, STATUS_TIMEOUT_MS);
  }

  // Show duplicate file conflict dialog — returns "keep-both" or "cancel"
  function showDuplicateDialog(filename) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "dialog-overlay";
      overlay.innerHTML = `
        <div class="dialog-box">
          <h3>File Already Exists</h3>
          <p>A file named <strong>${escapeHtml(filename)}</strong> already exists in the destination folder.</p>
          <div class="dialog-actions">
            <button class="dialog-btn dialog-btn-danger" data-action="replace">Replace</button>
            <button class="dialog-btn dialog-btn-primary" data-action="keep-both">Keep Both</button>
            <button class="dialog-btn dialog-btn-secondary" data-action="skip">Skip</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.addEventListener("click", (e) => {
        const action = e.target.getAttribute("data-action");
        if (action) {
          overlay.remove();
          resolve(action);
        }
      });
    });
  }

  // Move file with duplicate detection — interactive (shows dialog)
  async function moveWithDuplicateCheck(sourcePath, destFolder, fileData) {
    try {
      const result = await invoke("move_file", { sourcePath, destFolder });
      return { success: true, result };
    } catch (error) {
      if (isDuplicateError(error)) {
        const filename = fileData?.name || pathBasename(sourcePath);
        const action = await showDuplicateDialog(filename);
        if (action === "replace") {
          const result = await invoke("replace_file", { sourcePath, destFolder });
          return { success: true, result, replaced: true };
        } else if (action === "keep-both") {
          const result = await invoke("move_file_with_rename", { sourcePath, destFolder });
          return { success: true, result, renamed: true };
        }
        return { success: false, skipped: true };
      }
      throw error;
    }
  }

  // Move file with silent auto-rename on duplicate (for auto-move / batch / retry)
  async function moveWithAutoRename(sourcePath, destFolder) {
    try {
      const result = await invoke("move_file", { sourcePath, destFolder });
      return result;
    } catch (error) {
      if (isDuplicateError(error)) {
        return await invoke("move_file_with_rename", { sourcePath, destFolder });
      }
      throw error;
    }
  }
}

// Utility functions (formatFileSize, escapeHtml, validateModuleName)
// are imported from utils.js
