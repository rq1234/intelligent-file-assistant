const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open } = window.__TAURI__.dialog;
const { getCurrentWindow } = window.__TAURI__.window;
const { openPath } = window.__TAURI__.opener;

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
  isImageFile,
  isContentExtractable,
  isToday,
  shouldGroupAsBatch,
  validateModuleName,
  buildCorrectionHistory,
  filterNewFiles,
} from "./utils.js";
import {
  addCorrection as dbAddCorrection,
  getCorrections as dbGetCorrections,
  addActivity as dbAddActivity,
  getActivityLog as dbGetActivityLog,
  markActivityUndone as dbMarkActivityUndone,
  clearActivityLog as dbClearActivityLog,
  migrateFromLocalStorage,
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
    const { LogicalSize, LogicalPosition } = window.__TAURI__.window;
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
    showOnboardingScreen();
  }
});

async function loadSavedConfig() {
  try {
    // Migrate localStorage data to SQLite (one-time operation)
    await migrateFromLocalStorage();

    // Load corrections and activity from SQLite database
    correctionLog = await dbGetCorrections();
    activityLog = await dbGetActivityLog();

    // Load other settings from localStorage (simpler for settings)
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
async function addActivityEntry(filename, fromFolder, toFolder) {
  // Save to SQLite database
  const entry = await dbAddActivity(filename, fromFolder, toFolder);
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
      if (selected && selected !== basePath) {
        basePath = selected;
        basePathInput.value = selected;
        // Clear modules - they belonged to the old folder
        userModules = [];
        renderModuleList();
        localStorage.setItem(STORAGE_KEYS.basePath, selected);
        localStorage.setItem(STORAGE_KEYS.modules, JSON.stringify(userModules));
        showOnboardingStatus("Folder set - click 'Scan' to detect modules", "info");
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
        <button class="module-remove-btn" title="Remove module" aria-label="Remove module">&times;</button>
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
    }, ONBOARDING_STATUS_TIMEOUT_MS);
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
  const darkModeToggle = document.getElementById("settings-dark-mode-toggle");
  const saveBtn = document.getElementById("settings-save-btn");
  const settingsStatus = document.getElementById("settings-status");

  // Auto-save helper - persists settings immediately
  function autoSaveSettings() {
    localStorage.setItem(STORAGE_KEYS.modules, JSON.stringify(userModules));
    localStorage.setItem(STORAGE_KEYS.basePath, basePath);
    localStorage.setItem(STORAGE_KEYS.watchPath, watchPath);
    localStorage.setItem(STORAGE_KEYS.autoMoveEnabled, String(autoMoveEnabled));
    localStorage.setItem(STORAGE_KEYS.autoMoveThreshold, String(autoMoveThreshold));
    localStorage.setItem(STORAGE_KEYS.notificationsEnabled, String(notificationsEnabled));
    localStorage.setItem(STORAGE_KEYS.theme, darkModeEnabled ? "dark" : "light");
  }

  // Populate current values (working directly with global state)
  basePathInput.value = basePath;
  watchPathInput.value = watchPath || "";
  notificationsToggle.checked = notificationsEnabled;
  notificationHint.style.display = "none";
  autoMoveToggle.checked = autoMoveEnabled;
  thresholdSlider.value = Math.round(autoMoveThreshold * 100);
  thresholdValue.textContent = Math.round(autoMoveThreshold * 100) + "%";
  thresholdGroup.style.display = autoMoveEnabled ? "block" : "none";
  darkModeToggle.checked = darkModeEnabled;
  renderSettingsModuleList();

  // Dark mode toggle - clone switch to remove old handlers
  const oldDarkModeSwitch = darkModeToggle.nextElementSibling;
  const darkModeSwitch = oldDarkModeSwitch.cloneNode(true);
  oldDarkModeSwitch.parentNode.replaceChild(darkModeSwitch, oldDarkModeSwitch);
  darkModeSwitch.addEventListener("click", function(e) {
    e.preventDefault();
    e.stopPropagation();
    darkModeToggle.checked = !darkModeToggle.checked;
    darkModeEnabled = darkModeToggle.checked;
    applyTheme();
    autoSaveSettings();
  });

  // Helper to close settings and return to main app
  function closeSettings() {
    document.getElementById("settings-screen").style.display = "none";
    document.getElementById("app-screen").style.display = "block";
    updateConfigSummary();
  }

  // Back button - just close (changes are auto-saved)
  const newBackBtn = backBtn.cloneNode(true);
  backBtn.parentNode.replaceChild(newBackBtn, backBtn);
  newBackBtn.addEventListener("click", closeSettings);

  // Done button - create folders and close (settings already auto-saved)
  const newSaveBtn = saveBtn.cloneNode(true);
  newSaveBtn.textContent = "Done";
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
  newSaveBtn.addEventListener("click", async () => {
    if (userModules.length === 0) {
      showSettingsStatus("Please add at least one module", "error");
      return;
    }
    if (!basePath) {
      showSettingsStatus("Please select an education folder", "error");
      return;
    }

    newSaveBtn.disabled = true;
    newSaveBtn.textContent = "Creating folders...";

    // Create any missing module folders
    for (const moduleName of userModules) {
      const folderPath = basePath + "\\" + moduleName;
      try {
        await invoke("create_folder", { path: folderPath });
      } catch (error) {
        console.error(`Failed to create folder for ${moduleName}:`, error);
      }
    }

    newSaveBtn.disabled = false;
    newSaveBtn.textContent = "Done";
    closeSettings();
  });

  // Browse education folder
  const newBrowseBase = browseBaseBtn.cloneNode(true);
  browseBaseBtn.parentNode.replaceChild(newBrowseBase, browseBaseBtn);
  newBrowseBase.addEventListener("click", async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select your education folder" });
      if (selected && selected !== basePath) {
        basePath = selected;
        basePathInput.value = selected;
        // Clear modules - they belonged to the old folder
        userModules = [];
        renderSettingsModuleList();
        autoSaveSettings();
        showSettingsStatus("Folder changed - click 'Scan' to detect modules", "info");
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
        watchPath = selected;
        watchPathInput.value = selected;
        autoSaveSettings();
        showSettingsStatus("Watch folder saved", "success");
      }
    } catch (error) {
      showSettingsStatus(`Error: ${error}`, "error");
    }
  });

  // Scan existing folders
  const newScanBtn = scanFoldersBtn.cloneNode(true);
  scanFoldersBtn.parentNode.replaceChild(newScanBtn, scanFoldersBtn);
  newScanBtn.addEventListener("click", async () => {
    if (!basePath) {
      showSettingsStatus("Please select your education folder first", "error");
      return;
    }
    newScanBtn.disabled = true;
    newScanBtn.textContent = "Scanning...";
    try {
      const folders = await invoke("scan_folders", { path: basePath });
      if (folders.length === 0) {
        showSettingsStatus("No subfolders found", "info");
      } else {
        userModules = folders;
        renderSettingsModuleList();
        autoSaveSettings();
        showSettingsStatus(`Found ${folders.length} course folders - saved!`, "success");
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
      if (userModules.some(m => m.toLowerCase() === name.toLowerCase())) {
        showSettingsStatus("Module already exists", "error");
        return;
      }
      userModules.push(name);
      renderSettingsModuleList();
      autoSaveSettings();
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

  // Notification toggle - clone switch to remove old handlers
  notificationsToggle.checked = notificationsEnabled;
  const oldNotifSwitch = notificationsToggle.nextElementSibling;
  const notifSwitch = oldNotifSwitch.cloneNode(true);
  oldNotifSwitch.parentNode.replaceChild(notifSwitch, oldNotifSwitch);
  notifSwitch.addEventListener("click", async function(e) {
    e.preventDefault();
    e.stopPropagation();

    const newState = !notificationsToggle.checked;
    notificationsToggle.checked = newState;
    notificationsEnabled = newState;

    if (newState && notificationApi) {
      try {
        const granted = await notificationApi.isPermissionGranted();
        if (!granted) {
          const permission = await notificationApi.requestPermission();
          if (permission !== "granted") {
            notificationsToggle.checked = false;
            notificationsEnabled = false;
            notificationHint.style.display = "block";
          }
        }
      } catch (err) {
        console.error("Notification permission error:", err);
      }
    }

    if (!newState) {
      notificationHint.style.display = "none";
    }
    autoSaveSettings();
  });

  // Auto-move toggle - clone switch to remove old handlers
  autoMoveToggle.checked = autoMoveEnabled;
  const oldAutoMoveSwitch = autoMoveToggle.nextElementSibling;
  const autoMoveSwitch = oldAutoMoveSwitch.cloneNode(true);
  oldAutoMoveSwitch.parentNode.replaceChild(autoMoveSwitch, oldAutoMoveSwitch);
  autoMoveSwitch.addEventListener("click", function(e) {
    e.preventDefault();
    e.stopPropagation();
    autoMoveToggle.checked = !autoMoveToggle.checked;
    autoMoveEnabled = autoMoveToggle.checked;
    thresholdGroup.style.display = autoMoveEnabled ? "block" : "none";
    autoSaveSettings();
  });

  // Threshold slider - use oninput to replace any existing handler
  thresholdSlider.value = Math.round(autoMoveThreshold * 100);
  thresholdSlider.oninput = function() {
    autoMoveThreshold = parseInt(this.value) / 100;
    thresholdValue.textContent = this.value + "%";
    autoSaveSettings();
  };

  function renderSettingsModuleList() {
    moduleList.innerHTML = "";
    userModules.forEach((name, index) => {
      const item = document.createElement("div");
      item.className = "module-item";
      item.innerHTML = `
        <span class="module-name">${escapeHtml(name)}</span>
        <button class="module-remove-btn" title="Remove module" aria-label="Remove module">&times;</button>
      `;
      item.querySelector(".module-remove-btn").addEventListener("click", () => {
        userModules.splice(index, 1);
        renderSettingsModuleList();
        autoSaveSettings();
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
    }, ONBOARDING_STATUS_TIMEOUT_MS);
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
    showSettingsScreen();
  });

  // Set up event listeners
  startWatchingBtn.addEventListener("click", toggleWatching);
  acceptAllHighBtn.addEventListener("click", acceptAllHighConfidence);
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

  // Quick-create a module from an unsorted file card
  async function quickCreateModule(fileInfo, fileItem, classification) {
    const name = prompt("Enter new module name:");
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
    const fullPath = basePath + "\\" + trimmed;
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

    // Auto-select and move to the new module
    const folderSelect = fileItem.querySelector(".folder-select");
    if (folderSelect) {
      folderSelect.value = fullPath;
    }

    // Update suggestion display
    const suggestionDiv = fileItem.querySelector(".ai-suggestion");
    if (suggestionDiv) {
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
    }

    updateConfigSummary();
    scanFolderBtn.disabled = false;
    showStatus(`Module "${trimmed}" created`, "success");
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
        const parts = filePath.replace(/\//g, "\\").split("\\");
        const name = parts.pop();
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

      // Get the first (top) file card in the list
      const topCard = fileList.querySelector(".file-item");
      if (!topCard) return;

      switch (e.key.toLowerCase()) {
        case "a": {
          // Accept AI suggestion
          const acceptBtn = topCard.querySelector(".accept-btn");
          if (acceptBtn && !acceptBtn.disabled) {
            acceptBtn.click();
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

  // Two-pass classification:
  // Pass 1: Classify by filename (fast, cheap)
  // Pass 2: If confidence < threshold, use content analysis (vision for images, text extraction for PDFs)
  async function invokeClassify(fileInfo, statusCallback) {
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
        const suggestedModuleName = classification.suggested_folder.split("\\").pop();
        console.log(`[AUTO-MOVE] ${fileInfo.name} → ${suggestedModuleName} (${Math.round(classification.confidence * 100)}%)`);

        try {
          await moveWithAutoRename(fileInfo.path, classification.suggested_folder);

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
      }

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
      const moveResult = await moveWithDuplicateCheck(filePath, destFolder, fileData);
      if (!moveResult.success) {
        buttonElement.disabled = false;
        buttonElement.textContent = "Move";
        if (moveResult.cancelled) showStatus("Move cancelled", "info");
        return;
      }

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
      const statusText = moveResult.renamed ? `${moveResult.result} (kept both)` : moveResult.result;
      showStatus(statusText, "success");
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
      const moveResult = await moveWithDuplicateCheck(filePath, suggestedFolder, fileData);
      if (!moveResult.success) {
        buttonElement.disabled = false;
        buttonElement.textContent = "Accept";
        if (moveResult.cancelled) showStatus("Move cancelled", "info");
        return;
      }

      // Log as accepted - AI got it right
      logCorrection(filename, moduleName, moduleName, "accepted");

      // Activity log and undo
      const movedDestPath = suggestedFolder + "\\" + filename;
      addActivityEntry(filename, watchPath, suggestedFolder);
      renderActivityLog();
      showUndoToast(filename, movedDestPath, watchPath);

      removeFileFromUI(filePath, fileItem);
      const statusText = moveResult.renamed ? `${moveResult.result} (kept both)` : `${moveResult.result} (AI suggestion accepted)`;
      showStatus(statusText, "success");
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
        await moveWithAutoRename(filePath, suggestedFolder);

        const index = detectedFiles.findIndex(f => f.path === filePath);
        const filename = index > -1 ? detectedFiles[index].name : filePath.split("\\").pop();
        if (index > -1) detectedFiles.splice(index, 1);

        addActivityEntry(filename, watchPath, suggestedFolder);

        fileItem.style.opacity = "0";
        setTimeout(() => fileItem.remove(), FILE_REMOVE_ANIMATION_MS);
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
        await moveWithAutoRename(filePath, suggestedFolder);

        const index = detectedFiles.findIndex(f => f.path === filePath);
        const filename = index > -1 ? detectedFiles[index].name : filePath.split("\\").pop();
        if (index > -1) detectedFiles.splice(index, 1);

        addActivityEntry(filename, watchPath, suggestedFolder);

        fileItem.style.opacity = "0";
        setTimeout(() => fileItem.remove(), FILE_REMOVE_ANIMATION_MS);
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
  function showUndoToast(filename, destPath, originalFolder) {
    // Cancel any existing undo timer
    cancelUndo();

    lastMove = { filename, destPath, originalFolder, timestamp: Date.now() };
    undoToastMsg.textContent = `Moved "${filename}"`;
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
  }

  // isToday is imported from utils.js

  // Show status message
  function showStatus(message, type = "info") {
    statusMsg.textContent = message;
    statusMsg.className = `status-msg ${type}`;
    setTimeout(() => {
      if (statusMsg.textContent === message) {
        statusMsg.textContent = "";
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
            <button class="dialog-btn dialog-btn-primary" data-action="keep-both">Keep Both</button>
            <button class="dialog-btn dialog-btn-secondary" data-action="cancel">Cancel</button>
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
      const errorMsg = error.toString();
      if (errorMsg.includes("File already exists at destination")) {
        const filename = fileData?.name || sourcePath.split("\\").pop();
        const action = await showDuplicateDialog(filename);
        if (action === "keep-both") {
          const result = await invoke("move_file_with_rename", { sourcePath, destFolder });
          return { success: true, result, renamed: true };
        }
        return { success: false, cancelled: true };
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
      const errorMsg = error.toString();
      if (errorMsg.includes("File already exists at destination")) {
        return await invoke("move_file_with_rename", { sourcePath, destFolder });
      }
      throw error;
    }
  }
}

// Utility functions (formatFileSize, escapeHtml, validateModuleName)
// are imported from utils.js
