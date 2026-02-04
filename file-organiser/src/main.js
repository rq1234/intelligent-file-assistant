const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open } = window.__TAURI__.dialog;

// ============================================================
// LOCAL STORAGE KEYS
// ============================================================
const STORAGE_KEYS = {
  modules: "fileorg_modules",       // Array of module names
  basePath: "fileorg_base_path",    // Base education folder path
  onboarded: "fileorg_onboarded",   // Boolean - has user completed setup
  corrections: "fileorg_corrections", // Array of correction entries for AI learning
  activityLog: "fileorg_activity_log", // Array of activity log entries
  watchPath: "fileorg_watch_path",  // Watch folder path
  autoMoveEnabled: "fileorg_auto_move_enabled", // Boolean - auto-move toggle
  autoMoveThreshold: "fileorg_auto_move_threshold", // Number 0.7-1.0
  notificationsEnabled: "fileorg_notifications_enabled", // Boolean - notifications toggle
};

const MAX_CORRECTIONS = 50; // Keep last 50 corrections to avoid bloating prompt
const MAX_ACTIVITY_LOG = 100; // Keep last 100 activity entries
const UNDO_TIMEOUT = 10000; // 10 seconds to undo

// ============================================================
// STATE
// ============================================================
let watchPath = "";
let detectedFiles = [];
let isWatching = false;
let retryQueue = [];

// Batch detection state
let pendingBatch = [];
let batchTimer = null;

// Two-tier batch detection thresholds
const RAPID_WINDOW = 2000;
const BATCH_WINDOW = 5000;
const MIN_BATCH_SIZE = 3;

// User config (loaded from localStorage)
let userModules = [];   // e.g. ["Machine Learning", "Operations Research", ...]
let basePath = "";      // e.g. "C:\Users\rongq\OneDrive\0 Year 2"

// Skipped files (non-educational)
let skippedFiles = [];  // { name, path, size, reasoning }

// Ignored files (user-dismissed)
let ignoredFiles = [];  // { name, path, size }

// Correction history for AI learning
let correctionLog = []; // { filename, aiSuggested, userChose, type }

// Activity log
let activityLog = []; // { filename, from, to, timestamp, undone }

// Undo state
let undoTimer = null;
let undoCountdownInterval = null;
let lastMove = null; // { filename, sourcePath, destPath, originalFolder }

// Auto-move settings
let autoMoveEnabled = false;
let autoMoveThreshold = 0.9;

// Notification settings
let notificationsEnabled = false;
let notificationApi = null;

// ============================================================
// INITIALIZATION
// ============================================================
window.addEventListener("DOMContentLoaded", () => {
  // Check if user has already completed onboarding
  const isOnboarded = localStorage.getItem(STORAGE_KEYS.onboarded) === "true";

  if (isOnboarded) {
    loadSavedConfig();
    showAppScreen();
  } else {
    showOnboardingScreen();
  }
});

function loadSavedConfig() {
  try {
    const savedModules = localStorage.getItem(STORAGE_KEYS.modules);
    const savedBasePath = localStorage.getItem(STORAGE_KEYS.basePath);
    const savedCorrections = localStorage.getItem(STORAGE_KEYS.corrections);
    const savedActivity = localStorage.getItem(STORAGE_KEYS.activityLog);
    const savedWatchPath = localStorage.getItem(STORAGE_KEYS.watchPath);
    const savedAutoMove = localStorage.getItem(STORAGE_KEYS.autoMoveEnabled);
    const savedThreshold = localStorage.getItem(STORAGE_KEYS.autoMoveThreshold);
    if (savedModules) {
      const parsed = JSON.parse(savedModules);
      if (Array.isArray(parsed)) userModules = parsed.filter(m => typeof m === "string");
    }
    if (savedBasePath) basePath = savedBasePath;
    if (savedCorrections) {
      const parsed = JSON.parse(savedCorrections);
      if (Array.isArray(parsed)) correctionLog = parsed;
    }
    if (savedActivity) {
      const parsed = JSON.parse(savedActivity);
      if (Array.isArray(parsed)) activityLog = parsed;
    }
    if (savedWatchPath) watchPath = savedWatchPath;
    const savedNotifications = localStorage.getItem(STORAGE_KEYS.notificationsEnabled);
    if (savedNotifications !== null) notificationsEnabled = savedNotifications === "true";
    if (savedAutoMove !== null) autoMoveEnabled = savedAutoMove === "true";
    if (savedThreshold !== null) {
      const t = parseFloat(savedThreshold);
      if (!isNaN(t)) autoMoveThreshold = Math.min(1.0, Math.max(0.7, t));
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
    notificationApi.sendNotification({ title, body });
  } catch (e) {
    console.error("Notification failed:", e);
  }
}

// Save a correction to the log
function logCorrection(filename, aiSuggested, userChose, type) {
  correctionLog.push({ filename, aiSuggested, userChose, type, timestamp: Date.now() });
  // Keep only the most recent corrections
  if (correctionLog.length > MAX_CORRECTIONS) {
    correctionLog = correctionLog.slice(-MAX_CORRECTIONS);
  }
  localStorage.setItem(STORAGE_KEYS.corrections, JSON.stringify(correctionLog));
  console.log(`[CORRECTION] ${type}: "${filename}" | AI said "${aiSuggested}" → User chose "${userChose}"`);
}

// Build correction history strings for the AI prompt
// Recent corrections are weighted more heavily and per-folder accuracy stats are appended
function buildCorrectionHistory() {
  if (correctionLog.length === 0) return [];

  // Prioritize recent corrections: show last 20 in full, summarize older ones
  const recentCount = 20;
  const recent = correctionLog.slice(-recentCount);
  const older = correctionLog.slice(0, -recentCount);

  const lines = [];

  // Add per-folder accuracy summary
  const folderStats = {};
  for (const c of correctionLog) {
    if (c.type === "dismissed") continue;
    const folder = c.userChose || c.aiSuggested;
    if (!folder) continue;
    if (!folderStats[folder]) folderStats[folder] = { correct: 0, total: 0 };
    folderStats[folder].total++;
    if (c.type === "accepted") folderStats[folder].correct++;
  }

  const statsLines = Object.entries(folderStats)
    .filter(([, s]) => s.total >= 2)
    .map(([folder, s]) => `${folder}: ${Math.round((s.correct / s.total) * 100)}% accuracy (${s.correct}/${s.total})`)
    .join(", ");

  if (statsLines) {
    lines.push(`[Folder accuracy stats: ${statsLines}]`);
  }

  // Summarize older corrections if any
  if (older.length > 0) {
    const olderCorrections = older.filter(c => c.type === "corrected").length;
    const olderAccepted = older.filter(c => c.type === "accepted").length;
    const olderDismissed = older.filter(c => c.type === "dismissed").length;
    lines.push(`[Earlier history: ${olderAccepted} accepted, ${olderCorrections} corrected, ${olderDismissed} dismissed]`);
  }

  // Add recent corrections in full detail
  for (const c of recent) {
    if (c.type === "accepted") {
      lines.push(`"${c.filename}" → ${c.userChose} (correct)`);
    } else if (c.type === "corrected") {
      lines.push(`"${c.filename}" → AI suggested ${c.aiSuggested}, but user moved to ${c.userChose}`);
    } else if (c.type === "dismissed") {
      lines.push(`"${c.filename}" → User dismissed this file (didn't want to organize it)`);
    }
  }

  return lines;
}

// Save an activity log entry
function addActivityEntry(filename, fromFolder, toFolder) {
  const entry = {
    filename,
    from: fromFolder,
    to: toFolder,
    timestamp: Date.now(),
    undone: false,
  };
  activityLog.unshift(entry); // newest first
  if (activityLog.length > MAX_ACTIVITY_LOG) {
    activityLog = activityLog.slice(0, MAX_ACTIVITY_LOG);
  }
  localStorage.setItem(STORAGE_KEYS.activityLog, JSON.stringify(activityLog));
  return entry;
}

// Mark the most recent activity entry as undone
function markActivityUndone(timestamp) {
  const entry = activityLog.find(e => e.timestamp === timestamp);
  if (entry) {
    entry.undone = true;
    localStorage.setItem(STORAGE_KEYS.activityLog, JSON.stringify(activityLog));
  }
}

// ============================================================
// ONBOARDING SCREEN
// ============================================================
function showOnboardingScreen() {
  document.getElementById("onboarding-screen").style.display = "block";
  document.getElementById("app-screen").style.display = "none";
  document.getElementById("settings-screen").style.display = "none";
  initOnboarding();
}

function initOnboarding() {
  const moduleList = document.getElementById("module-list");
  const addModuleBtn = document.getElementById("add-module-btn");
  const addModuleInput = document.getElementById("add-module-input");
  const newModuleName = document.getElementById("new-module-name");
  const confirmAddBtn = document.getElementById("confirm-add-btn");
  const cancelAddBtn = document.getElementById("cancel-add-btn");
  const scanFoldersBtn = document.getElementById("scan-folders-btn");
  const browseBaseBtn = document.getElementById("browse-base-btn");
  const basePathInput = document.getElementById("base-path-input");
  const continueBtn = document.getElementById("continue-btn");
  const onboardingStatus = document.getElementById("onboarding-status");

  // Load any previously saved base path
  const savedBasePath = localStorage.getItem(STORAGE_KEYS.basePath);
  if (savedBasePath) {
    basePath = savedBasePath;
    basePathInput.value = savedBasePath;
  }

  // --- Browse for base education folder ---
  browseBaseBtn.addEventListener("click", async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select your education folder (e.g. Year 2)",
      });
      if (selected) {
        basePath = selected;
        basePathInput.value = selected;
        localStorage.setItem(STORAGE_KEYS.basePath, selected);
        showOnboardingStatus("Education folder set", "success");
        updateContinueBtn();
      }
    } catch (error) {
      showOnboardingStatus(`Error: ${error}`, "error");
    }
  });

  // --- Scan existing folders ---
  scanFoldersBtn.addEventListener("click", async () => {
    if (!basePath) {
      showOnboardingStatus("Please select your education folder first (Browse button below)", "error");
      return;
    }

    scanFoldersBtn.disabled = true;
    scanFoldersBtn.textContent = "Scanning...";

    try {
      const folders = await invoke("scan_folders", { path: basePath });

      if (folders.length === 0) {
        showOnboardingStatus("No subfolders found in that directory", "info");
      } else {
        // Replace current module list with scanned folders
        userModules = folders;
        renderModuleList();
        showOnboardingStatus(`Found ${folders.length} course folders`, "success");
      }
    } catch (error) {
      showOnboardingStatus(`Scan failed: ${error}`, "error");
    }

    scanFoldersBtn.disabled = false;
    scanFoldersBtn.textContent = "Scan existing course folders";
    updateContinueBtn();
  });

  // --- Add Module button ---
  addModuleBtn.addEventListener("click", () => {
    addModuleInput.style.display = "flex";
    addModuleBtn.style.display = "none";
    newModuleName.value = "";
    newModuleName.focus();
  });

  // --- Confirm add module ---
  const doAddModule = () => {
    const name = newModuleName.value.trim();
    if (name) {
      const validationError = validateModuleName(name);
      if (validationError) {
        showOnboardingStatus(validationError, "error");
        return;
      }
      // Check for duplicates
      if (userModules.some(m => m.toLowerCase() === name.toLowerCase())) {
        showOnboardingStatus("Module already exists", "error");
        return;
      }
      userModules.push(name);
      renderModuleList();
      updateContinueBtn();
    }
    addModuleInput.style.display = "none";
    addModuleBtn.style.display = "block";
    newModuleName.value = "";
  };

  confirmAddBtn.addEventListener("click", doAddModule);
  newModuleName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doAddModule();
    if (e.key === "Escape") {
      addModuleInput.style.display = "none";
      addModuleBtn.style.display = "block";
    }
  });

  // --- Cancel add ---
  cancelAddBtn.addEventListener("click", () => {
    addModuleInput.style.display = "none";
    addModuleBtn.style.display = "block";
  });

  // --- Continue ---
  continueBtn.addEventListener("click", async () => {
    if (userModules.length === 0 || !basePath) return;

    continueBtn.disabled = true;
    continueBtn.textContent = "Setting up...";

    // Create any missing folders
    for (const moduleName of userModules) {
      const folderPath = basePath + "\\" + moduleName;
      try {
        await invoke("create_folder", { path: folderPath });
      } catch (error) {
        console.error(`Failed to create folder for ${moduleName}:`, error);
      }
    }

    // Save to localStorage
    localStorage.setItem(STORAGE_KEYS.modules, JSON.stringify(userModules));
    localStorage.setItem(STORAGE_KEYS.basePath, basePath);
    localStorage.setItem(STORAGE_KEYS.onboarded, "true");

    // Switch to main app
    showAppScreen();
  });

  // Initial render
  renderModuleList();
  updateContinueBtn();

  // --- Helper: render module list ---
  function renderModuleList() {
    moduleList.innerHTML = "";
    userModules.forEach((name, index) => {
      const item = document.createElement("div");
      item.className = "module-item";
      item.innerHTML = `
        <span class="module-name">${escapeHtml(name)}</span>
        <button class="module-remove-btn" title="Remove module">&times;</button>
      `;
      item.querySelector(".module-remove-btn").addEventListener("click", () => {
        userModules.splice(index, 1);
        renderModuleList();
        updateContinueBtn();
      });
      moduleList.appendChild(item);
    });
  }

  // --- Helper: update continue button state ---
  function updateContinueBtn() {
    continueBtn.disabled = userModules.length === 0 || !basePath;
  }

  // --- Helper: show status on onboarding screen ---
  function showOnboardingStatus(message, type) {
    onboardingStatus.textContent = message;
    onboardingStatus.className = `status-msg ${type}`;
    setTimeout(() => {
      if (onboardingStatus.textContent === message) {
        onboardingStatus.textContent = "";
        onboardingStatus.className = "status-msg";
      }
    }, 4000);
  }
}

// ============================================================
// SETTINGS SCREEN
// ============================================================
function showSettingsScreen() {
  document.getElementById("app-screen").style.display = "none";
  document.getElementById("onboarding-screen").style.display = "none";
  document.getElementById("settings-screen").style.display = "block";
  initSettings();
}

function initSettings() {
  const backBtn = document.getElementById("settings-back-btn");
  const basePathInput = document.getElementById("settings-base-path");
  const browseBaseBtn = document.getElementById("settings-browse-base-btn");
  const moduleList = document.getElementById("settings-module-list");
  const addModuleBtn = document.getElementById("settings-add-module-btn");
  const addModuleInput = document.getElementById("settings-add-module-input");
  const newModuleName = document.getElementById("settings-new-module-name");
  const confirmAddBtn = document.getElementById("settings-confirm-add-btn");
  const cancelAddBtn = document.getElementById("settings-cancel-add-btn");
  const scanFoldersBtn = document.getElementById("settings-scan-folders-btn");
  const watchPathInput = document.getElementById("settings-watch-path");
  const browseWatchBtn = document.getElementById("settings-browse-watch-btn");
  const autoMoveToggle = document.getElementById("settings-auto-move-toggle");
  const thresholdSlider = document.getElementById("settings-threshold-slider");
  const thresholdValue = document.getElementById("threshold-value");
  const thresholdGroup = document.getElementById("threshold-slider-group");
  const notificationsToggle = document.getElementById("settings-notifications-toggle");
  const notificationHint = document.getElementById("notification-permission-hint");
  const saveBtn = document.getElementById("settings-save-btn");
  const settingsStatus = document.getElementById("settings-status");

  // Work with copies so we can discard changes on back
  let tempModules = [...userModules];
  let tempBasePath = basePath;
  let tempWatchPath = watchPath || "C:\\Users\\rongq\\Downloads";
  let tempAutoMoveEnabled = autoMoveEnabled;
  let tempAutoMoveThreshold = autoMoveThreshold;
  let tempNotificationsEnabled = notificationsEnabled;

  // Populate current values
  basePathInput.value = tempBasePath;
  watchPathInput.value = tempWatchPath;
  notificationsToggle.checked = tempNotificationsEnabled;
  notificationHint.style.display = "none";
  autoMoveToggle.checked = tempAutoMoveEnabled;
  thresholdSlider.value = Math.round(tempAutoMoveThreshold * 100);
  thresholdValue.textContent = Math.round(tempAutoMoveThreshold * 100) + "%";
  thresholdGroup.style.display = tempAutoMoveEnabled ? "block" : "none";
  renderSettingsModuleList();

  // Remove old listeners by cloning elements
  const newBackBtn = backBtn.cloneNode(true);
  backBtn.parentNode.replaceChild(newBackBtn, backBtn);
  newBackBtn.addEventListener("click", () => {
    document.getElementById("settings-screen").style.display = "none";
    document.getElementById("app-screen").style.display = "block";
  });

  const newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
  newSaveBtn.addEventListener("click", async () => {
    if (tempModules.length === 0) {
      showSettingsStatus("Please add at least one module", "error");
      return;
    }
    if (!tempBasePath) {
      showSettingsStatus("Please select an education folder", "error");
      return;
    }

    newSaveBtn.disabled = true;
    newSaveBtn.textContent = "Saving...";

    // Create any missing folders
    for (const moduleName of tempModules) {
      const folderPath = tempBasePath + "\\" + moduleName;
      try {
        await invoke("create_folder", { path: folderPath });
      } catch (error) {
        console.error(`Failed to create folder for ${moduleName}:`, error);
      }
    }

    // Apply changes to state
    userModules = tempModules;
    basePath = tempBasePath;
    watchPath = tempWatchPath;
    autoMoveEnabled = tempAutoMoveEnabled;
    autoMoveThreshold = tempAutoMoveThreshold;
    notificationsEnabled = tempNotificationsEnabled;

    // Save to localStorage
    localStorage.setItem(STORAGE_KEYS.modules, JSON.stringify(userModules));
    localStorage.setItem(STORAGE_KEYS.basePath, basePath);
    localStorage.setItem(STORAGE_KEYS.watchPath, watchPath);
    localStorage.setItem(STORAGE_KEYS.autoMoveEnabled, String(autoMoveEnabled));
    localStorage.setItem(STORAGE_KEYS.autoMoveThreshold, String(autoMoveThreshold));
    localStorage.setItem(STORAGE_KEYS.notificationsEnabled, String(notificationsEnabled));

    newSaveBtn.disabled = false;
    newSaveBtn.textContent = "Save Settings";

    // Return to app and refresh
    document.getElementById("settings-screen").style.display = "none";
    document.getElementById("app-screen").style.display = "block";
    updateConfigSummary();
  });

  // Browse education folder
  const newBrowseBase = browseBaseBtn.cloneNode(true);
  browseBaseBtn.parentNode.replaceChild(newBrowseBase, browseBaseBtn);
  newBrowseBase.addEventListener("click", async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select your education folder" });
      if (selected) {
        tempBasePath = selected;
        basePathInput.value = selected;
        showSettingsStatus("Education folder updated", "success");
      }
    } catch (error) {
      showSettingsStatus(`Error: ${error}`, "error");
    }
  });

  // Browse watch folder
  const newBrowseWatch = browseWatchBtn.cloneNode(true);
  browseWatchBtn.parentNode.replaceChild(newBrowseWatch, browseWatchBtn);
  newBrowseWatch.addEventListener("click", async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select folder to watch" });
      if (selected) {
        tempWatchPath = selected;
        watchPathInput.value = selected;
        showSettingsStatus("Watch folder updated", "success");
      }
    } catch (error) {
      showSettingsStatus(`Error: ${error}`, "error");
    }
  });

  // Scan existing folders
  const newScanBtn = scanFoldersBtn.cloneNode(true);
  scanFoldersBtn.parentNode.replaceChild(newScanBtn, scanFoldersBtn);
  newScanBtn.addEventListener("click", async () => {
    if (!tempBasePath) {
      showSettingsStatus("Please select your education folder first", "error");
      return;
    }
    newScanBtn.disabled = true;
    newScanBtn.textContent = "Scanning...";
    try {
      const folders = await invoke("scan_folders", { path: tempBasePath });
      if (folders.length === 0) {
        showSettingsStatus("No subfolders found", "info");
      } else {
        tempModules = folders;
        renderSettingsModuleList();
        showSettingsStatus(`Found ${folders.length} course folders`, "success");
      }
    } catch (error) {
      showSettingsStatus(`Scan failed: ${error}`, "error");
    }
    newScanBtn.disabled = false;
    newScanBtn.textContent = "Scan existing course folders";
  });

  // Add module
  const newAddBtn = addModuleBtn.cloneNode(true);
  addModuleBtn.parentNode.replaceChild(newAddBtn, addModuleBtn);
  newAddBtn.addEventListener("click", () => {
    addModuleInput.style.display = "flex";
    newAddBtn.style.display = "none";
    newModuleName.value = "";
    newModuleName.focus();
  });

  const doAdd = () => {
    const name = newModuleName.value.trim();
    if (name) {
      const validationError = validateModuleName(name);
      if (validationError) {
        showSettingsStatus(validationError, "error");
        return;
      }
      if (tempModules.some(m => m.toLowerCase() === name.toLowerCase())) {
        showSettingsStatus("Module already exists", "error");
        return;
      }
      tempModules.push(name);
      renderSettingsModuleList();
    }
    addModuleInput.style.display = "none";
    newAddBtn.style.display = "block";
    newModuleName.value = "";
  };

  const newConfirmBtn = confirmAddBtn.cloneNode(true);
  confirmAddBtn.parentNode.replaceChild(newConfirmBtn, confirmAddBtn);
  newConfirmBtn.addEventListener("click", doAdd);

  const newCancelBtn = cancelAddBtn.cloneNode(true);
  cancelAddBtn.parentNode.replaceChild(newCancelBtn, cancelAddBtn);
  newCancelBtn.addEventListener("click", () => {
    addModuleInput.style.display = "none";
    newAddBtn.style.display = "block";
  });

  // Handle enter/escape in module input
  newModuleName.onkeydown = (e) => {
    if (e.key === "Enter") doAdd();
    if (e.key === "Escape") {
      addModuleInput.style.display = "none";
      newAddBtn.style.display = "block";
    }
  };

  // Notification toggle
  notificationsToggle.onchange = async () => {
    if (notificationsToggle.checked) {
      // Request OS permission when enabling
      try {
        if (notificationApi) {
          const granted = await notificationApi.isPermissionGranted();
          if (!granted) {
            const permission = await notificationApi.requestPermission();
            if (permission !== "granted") {
              notificationsToggle.checked = false;
              notificationHint.style.display = "block";
              tempNotificationsEnabled = false;
              return;
            }
          }
        }
        notificationHint.style.display = "none";
        tempNotificationsEnabled = true;
      } catch (e) {
        console.error("Notification permission error:", e);
        notificationsToggle.checked = false;
        tempNotificationsEnabled = false;
      }
    } else {
      tempNotificationsEnabled = false;
      notificationHint.style.display = "none";
    }
  };

  // Auto-move toggle
  autoMoveToggle.onchange = () => {
    tempAutoMoveEnabled = autoMoveToggle.checked;
    thresholdGroup.style.display = tempAutoMoveEnabled ? "block" : "none";
  };

  // Threshold slider
  thresholdSlider.oninput = () => {
    tempAutoMoveThreshold = parseInt(thresholdSlider.value) / 100;
    thresholdValue.textContent = thresholdSlider.value + "%";
  };

  function renderSettingsModuleList() {
    moduleList.innerHTML = "";
    tempModules.forEach((name, index) => {
      const item = document.createElement("div");
      item.className = "module-item";
      item.innerHTML = `
        <span class="module-name">${escapeHtml(name)}</span>
        <button class="module-remove-btn" title="Remove module">&times;</button>
      `;
      item.querySelector(".module-remove-btn").addEventListener("click", () => {
        tempModules.splice(index, 1);
        renderSettingsModuleList();
      });
      moduleList.appendChild(item);
    });
  }

  function showSettingsStatus(message, type) {
    settingsStatus.textContent = message;
    settingsStatus.className = `status-msg ${type}`;
    setTimeout(() => {
      if (settingsStatus.textContent === message) {
        settingsStatus.textContent = "";
        settingsStatus.className = "status-msg";
      }
    }, 4000);
  }
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
  const watchDisplay = watchPath ? watchPath.split("\\").pop() : "Not set";
  const moduleCount = userModules.length;
  const autoMoveDisplay = autoMoveEnabled ? `Auto-move: ${Math.round(autoMoveThreshold * 100)}%+` : "Auto-move: off";
  summary.innerHTML = `<strong>Watching:</strong> ${escapeHtml(watchDisplay)} &nbsp;|&nbsp; <strong>${moduleCount}</strong> modules &nbsp;|&nbsp; ${autoMoveDisplay}`;
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
  clearActivityBtn.addEventListener("click", () => {
    activityLog = [];
    localStorage.setItem(STORAGE_KEYS.activityLog, JSON.stringify(activityLog));
    renderActivityLog();
  });

  // Render existing activity log
  renderActivityLog();

  // Settings button -> settings screen
  settingsBtn.addEventListener("click", () => {
    showSettingsScreen();
  });

  // Set up event listeners
  startWatchingBtn.addEventListener("click", startWatching);
  acceptAllHighBtn.addEventListener("click", acceptAllHighConfidence);

  // Listen for file detection events from Rust
  setupFileListener();

  // Use saved watch path or default to Downloads
  if (!watchPath) {
    watchPath = "C:\\Users\\rongq\\Downloads";
    localStorage.setItem(STORAGE_KEYS.watchPath, watchPath);
  }
  startWatchingBtn.disabled = false;
  updateConfigSummary();
  showStatus("Ready to watch", "info");

  // --- Build available folders from user modules ---
  function getAvailableFolders() {
    return userModules.map(name => basePath + "\\" + name);
  }

  // --- Build folder select options ---
  function buildFolderOptions() {
    let options = '<option value="">Choose destination...</option>';
    for (const name of userModules) {
      const fullPath = basePath + "\\" + name;
      options += `<option value="${escapeHtml(fullPath)}">${escapeHtml(name)}</option>`;
    }
    return options;
  }

  // Start watching the selected folder
  async function startWatching() {
    if (!watchPath) {
      showStatus("Please select a folder first", "error");
      return;
    }
    if (isWatching) {
      showStatus("Already watching!", "info");
      return;
    }

    try {
      await invoke("start_watching", { path: watchPath });
      isWatching = true;
      startWatchingBtn.textContent = "Watching...";
      startWatchingBtn.disabled = true;
      showStatus(`Watching ${watchPath}`, "success");
    } catch (error) {
      showStatus(`Failed to start watching: ${error}`, "error");
    }
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
      batchTimer = setTimeout(() => processBatch(), BATCH_WINDOW);

      if (pendingBatch.length === 1) {
        showStatus(`Detecting files... (${pendingBatch.length} file)`, "info");
      } else {
        showStatus(`Detecting files... (${pendingBatch.length} files)`, "info");
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

  // Two-tier batch detection logic
  function shouldGroupAsBatch(files) {
    if (files.length === 1) return false;

    let isRapidFire = true;
    for (let i = 1; i < files.length; i++) {
      if (files[i].timestamp - files[i - 1].timestamp > RAPID_WINDOW) {
        isRapidFire = false;
        break;
      }
    }
    if (isRapidFire) return true;

    if (files.length >= MIN_BATCH_SIZE) {
      const totalTimeSpan = files[files.length - 1].timestamp - files[0].timestamp;
      if (totalTimeSpan <= BATCH_WINDOW) return true;
    }

    return false;
  }

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

  // File type detection helpers
  const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
  const CONTENT_EXTRACTABLE_EXTS = ["pdf", "txt", "md", "csv"];
  const CONFIDENCE_THRESHOLD = 0.7; // Below this, try content-based second pass

  function getFileExt(filename) {
    return filename.split(".").pop().toLowerCase();
  }

  function isImageFile(filename) {
    return IMAGE_EXTS.includes(getFileExt(filename));
  }

  function isContentExtractable(filename) {
    return CONTENT_EXTRACTABLE_EXTS.includes(getFileExt(filename));
  }

  // Two-pass classification:
  // Pass 1: Classify by filename (fast, cheap)
  // Pass 2: If confidence < threshold, use content analysis (vision for images, text extraction for PDFs)
  async function invokeClassify(fileInfo, statusCallback) {
    const availableFolders = getAvailableFolders();
    const correctionHistory = buildCorrectionHistory();

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
    } else if (firstPass.confidence >= CONFIDENCE_THRESHOLD || (!firstPass.is_relevant && firstPass.confidence === 0)) {
      // High confidence or clearly not relevant (and not an image) — use first pass
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
      console.log(`[PASS 2] Low confidence (${firstPass.confidence}), extracting content for: ${fileInfo.name}`);
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
      if (autoMoveEnabled && classification.is_relevant &&
          classification.confidence >= autoMoveThreshold &&
          classification.suggested_folder) {
        const suggestedModuleName = classification.suggested_folder.split("\\").pop();
        console.log(`[AUTO-MOVE] ${fileInfo.name} → ${suggestedModuleName} (${Math.round(classification.confidence * 100)}%)`);

        try {
          await invoke("move_file", {
            sourcePath: fileInfo.path,
            destFolder: classification.suggested_folder,
          });

          const filename = fileInfo.name;
          const moduleName = suggestedModuleName;
          logCorrection(filename, moduleName, moduleName, "accepted");

          const movedDestPath = classification.suggested_folder + "\\" + filename;
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

      const suggestedModuleName = classification.suggested_folder.split("\\").pop();

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

      const fileIndex = detectedFiles.findIndex(f => f.path === fileInfo.path);
      if (fileIndex > -1) {
        detectedFiles[fileIndex].classification = classification;
        detectedFiles[fileIndex].isHighConfidence = classification.confidence > 0.8;
      }

      if (classification.confidence > 0.8) {
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
      const suggestedModuleName = classification.suggested_folder.split("\\").pop() || "Unknown";

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
          <strong>${escapeHtml(fileInfo.name)}</strong>
          <small>${formatFileSize(fileInfo.size)}</small>
        </div>
        <button class="dismiss-btn" title="Dismiss - don't organize this file">&times;</button>
      </div>
      <div class="file-path">
        <span>${escapeHtml(fileInfo.path)}</span>
      </div>
      <div class="ai-suggestion">
        <div class="ai-loading">Analyzing with AI...</div>
      </div>
      <div class="file-actions">
        <select class="folder-select">
          ${buildFolderOptions()}
        </select>
        <button class="move-btn">Move</button>
        <button class="ignore-btn">Ignore</button>
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
    const aiSuggested = fileData?.classification?.suggested_folder?.split("\\").pop() || "unknown";
    logCorrection(fileInfo.name, aiSuggested, "dismissed", "dismissed");

    removeFileFromUI(fileInfo.path, fileItem);
    addToIgnoredList(fileInfo);
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
    const filename = fileData?.name || filePath.split("\\").pop();
    const aiSuggested = fileData?.classification?.suggested_folder || "";
    const destModuleName = destFolder.split("\\").pop();
    const aiModuleName = aiSuggested.split("\\").pop();

    try {
      const result = await invoke("move_file", {
        sourcePath: filePath,
        destFolder: destFolder,
      });

      // Log correction: did user agree with AI or pick a different folder?
      if (aiSuggested && destFolder === aiSuggested) {
        logCorrection(filename, aiModuleName, destModuleName, "accepted");
      } else if (aiSuggested) {
        logCorrection(filename, aiModuleName, destModuleName, "corrected");
      }

      // Build the full destination path for undo
      const movedDestPath = destFolder + "\\" + filename;
      addActivityEntry(filename, watchPath, destFolder);
      renderActivityLog();
      showUndoToast(filename, movedDestPath, watchPath);

      removeFileFromUI(filePath, fileItem);
      sendAppNotification("File moved", `${filename} → ${destModuleName}`);
      showStatus(result, "success");
    } catch (error) {
      const errorMsg = error.toString().toLowerCase();
      if (errorMsg.includes("used by another process") || errorMsg.includes("permission denied") || errorMsg.includes("access denied")) {
        buttonElement.textContent = "Waiting...";
        showStatus("File is in use - will auto-move when available", "info");
        retryMoveFile(filePath, destFolder, fileItem, 0, (result) => {
          if (aiSuggested && destFolder === aiSuggested) {
            logCorrection(filename, aiModuleName, destModuleName, "accepted");
          } else if (aiSuggested) {
            logCorrection(filename, aiModuleName, destModuleName, "corrected");
          }
          const movedDestPath = destFolder + "\\" + filename;
          addActivityEntry(filename, watchPath, destFolder);
          renderActivityLog();
          showUndoToast(filename, movedDestPath, watchPath);
        });
      } else {
        showStatus(`Failed to move file: ${error}`, "error");
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
    const filename = fileData?.name || filePath.split("\\").pop();
    const moduleName = suggestedFolder.split("\\").pop();

    try {
      const result = await invoke("move_file", {
        sourcePath: filePath,
        destFolder: suggestedFolder,
      });

      // Log as accepted - AI got it right
      logCorrection(filename, moduleName, moduleName, "accepted");

      // Activity log and undo
      const movedDestPath = suggestedFolder + "\\" + filename;
      addActivityEntry(filename, watchPath, suggestedFolder);
      renderActivityLog();
      showUndoToast(filename, movedDestPath, watchPath);

      removeFileFromUI(filePath, fileItem);
      showStatus(`${result} (AI suggestion accepted)`, "success");
    } catch (error) {
      const errorMsg = error.toString().toLowerCase();
      if (errorMsg.includes("used by another process") || errorMsg.includes("permission denied") || errorMsg.includes("access denied")) {
        buttonElement.textContent = "Waiting...";
        showStatus("File is in use - will auto-move when available", "info");
        retryMoveFile(filePath, suggestedFolder, fileItem, 0, (result) => {
          logCorrection(filename, moduleName, moduleName, "accepted");
          const movedDestPath = suggestedFolder + "\\" + filename;
          addActivityEntry(filename, watchPath, suggestedFolder);
          renderActivityLog();
          showUndoToast(filename, movedDestPath, watchPath);
        });
      } else {
        showStatus(`Failed to move file: ${error}`, "error");
        buttonElement.disabled = false;
        buttonElement.textContent = "Accept";
      }
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
    }, 300);
  }

  // Retry with exponential backoff then patient waiting
  // onSuccess is an optional callback called after a successful move (before removing from UI)
  async function retryMoveFile(filePath, destFolder, fileItemElement, retryCount, onSuccess) {
    const quickRetries = 5;
    const quickDelays = [2000, 5000, 10000, 30000, 60000];
    const patientDelay = 600000;

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
      const result = await invoke("move_file", {
        sourcePath: filePath,
        destFolder: destFolder,
      });

      if (onSuccess) onSuccess(result);
      removeFileFromUI(filePath, fileItemElement);
      showStatus(`${result} (moved after ${retryCount + 1} retries)`, "success");
    } catch (error) {
      const errorMsg = error.toString().toLowerCase();
      if (errorMsg.includes("used by another process") || errorMsg.includes("permission denied") || errorMsg.includes("access denied")) {
        retryMoveFile(filePath, destFolder, fileItemElement, retryCount + 1, onSuccess);
      } else {
        if (suggestionDiv) {
          suggestionDiv.innerHTML = `<div class="ai-error">Failed to move: ${escapeHtml(String(error))}</div>`;
        }
        showStatus(`Failed to move file: ${error}`, "error");
      }
    }
  }

  // Update batch actions visibility
  function updateBatchActions() {
    const highConfidenceFiles = detectedFiles.filter(f => f.isHighConfidence);
    const count = highConfidenceFiles.length;

    if (count > 0) {
      batchActions.style.display = "block";
      highConfidenceCount.textContent = count;
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
        await invoke("move_file", { sourcePath: filePath, destFolder: suggestedFolder });

        const index = detectedFiles.findIndex(f => f.path === filePath);
        const filename = index > -1 ? detectedFiles[index].name : filePath.split("\\").pop();
        if (index > -1) detectedFiles.splice(index, 1);

        addActivityEntry(filename, watchPath, suggestedFolder);

        fileItem.style.opacity = "0";
        setTimeout(() => fileItem.remove(), 300);
        successCount++;
      } catch (error) {
        console.error(`Failed to move ${filePath}:`, error);
        failCount++;
        const errorMsg = error.toString().toLowerCase();
        if (errorMsg.includes("used by another process") || errorMsg.includes("permission denied") || errorMsg.includes("access denied")) {
          retryMoveFile(filePath, suggestedFolder, fileItem, 0);
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
        await invoke("move_file", { sourcePath: filePath, destFolder: suggestedFolder });

        const index = detectedFiles.findIndex(f => f.path === filePath);
        const filename = index > -1 ? detectedFiles[index].name : filePath.split("\\").pop();
        if (index > -1) detectedFiles.splice(index, 1);

        addActivityEntry(filename, watchPath, suggestedFolder);

        fileItem.style.opacity = "0";
        setTimeout(() => fileItem.remove(), 300);
        successCount++;
      } catch (error) {
        console.error(`Failed to move ${filePath}:`, error);
        failCount++;
        const errorMsg = error.toString().toLowerCase();
        if (errorMsg.includes("used by another process") || errorMsg.includes("permission denied") || errorMsg.includes("access denied")) {
          retryMoveFile(filePath, suggestedFolder, fileItem, 0);
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
        setTimeout(() => batchContainer.remove(), 300);
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
  function showUndoToast(filename, destPath, originalFolder) {
    // Cancel any existing undo timer
    cancelUndo();

    lastMove = { filename, destPath, originalFolder, timestamp: Date.now() };
    undoToastMsg.textContent = `Moved "${filename}"`;
    undoToast.style.display = "flex";

    let secondsLeft = UNDO_TIMEOUT / 1000;
    undoCountdownEl.textContent = secondsLeft;
    undoProgress.style.width = "100%";

    undoCountdownInterval = setInterval(() => {
      secondsLeft--;
      undoCountdownEl.textContent = secondsLeft;
      const pct = (secondsLeft / (UNDO_TIMEOUT / 1000)) * 100;
      undoProgress.style.width = pct + "%";
      if (secondsLeft <= 0) {
        cancelUndo();
      }
    }, 1000);

    undoTimer = setTimeout(() => {
      cancelUndo();
    }, UNDO_TIMEOUT);
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

    const { filename, destPath, originalFolder, timestamp } = lastMove;
    cancelUndo();

    try {
      const result = await invoke("undo_move", {
        filePath: destPath,
        originalFolder: originalFolder,
      });

      markActivityUndone(timestamp);
      renderActivityLog();
      showStatus(`Undo: "${filename}" restored`, "success");
    } catch (error) {
      showStatus(`Undo failed: ${error}`, "error");
    }
  }

  // Render the activity log
  function renderActivityLog() {
    activityCount.textContent = activityLog.filter(e => !e.undone).length;

    if (activityLog.length === 0) {
      activityList.innerHTML = '<p class="empty-msg">No activity yet.</p>';
      clearActivityBtn.style.display = "none";
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

      const toName = entry.to.split("\\").pop();

      item.innerHTML = `
        <span class="activity-time">${dateStr} ${timeStr}</span>
        <span class="activity-desc">${escapeHtml(entry.filename)} → <strong>${escapeHtml(toName)}</strong></span>
        ${entry.undone ? '<span class="activity-undone-badge">undone</span>' : ""}
      `;
      activityList.appendChild(item);
    }

    if (activityLog.length > 20) {
      const more = document.createElement("p");
      more.className = "activity-more";
      more.textContent = `+ ${activityLog.length - 20} older entries`;
      activityList.appendChild(more);
    }
  }

  function isToday(date) {
    const now = new Date();
    return date.getDate() === now.getDate() &&
      date.getMonth() === now.getMonth() &&
      date.getFullYear() === now.getFullYear();
  }

  // Show status message
  function showStatus(message, type = "info") {
    statusMsg.textContent = message;
    statusMsg.className = `status-msg ${type}`;
    setTimeout(() => {
      if (statusMsg.textContent === message) {
        statusMsg.textContent = "";
        statusMsg.className = "status-msg";
      }
    }, 5000);
  }
}

// ============================================================
// UTILITY
// ============================================================
function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Validate module name: no path traversal, no invalid Windows filename chars
function validateModuleName(name) {
  if (!name || name.trim().length === 0) {
    return "Module name cannot be empty";
  }
  // Block path traversal
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return "Module name cannot contain path separators or '..'";
  }
  // Block Windows-invalid filename characters
  const invalidChars = /[<>:"|?*]/;
  if (invalidChars.test(name)) {
    return "Module name cannot contain < > : \" | ? *";
  }
  // Block names that are just dots
  if (/^\.+$/.test(name.trim())) {
    return "Module name cannot be just dots";
  }
  // Block excessively long names
  if (name.trim().length > 100) {
    return "Module name is too long (max 100 characters)";
  }
  return null; // valid
}
