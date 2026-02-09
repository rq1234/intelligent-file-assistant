// ============================================================
// SETTINGS SCREEN
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { enable as autostartEnable, disable as autostartDisable, isEnabled as autostartIsEnabled } from "@tauri-apps/plugin-autostart";
import { STORAGE_KEYS, ONBOARDING_STATUS_TIMEOUT_MS } from "./constants.js";
import { validateModuleName, escapeHtml, pathJoin, pathBasename } from "./utils.js";
import { addRule as dbAddRule, deleteRule as dbDeleteRule } from "./storage.js";

export function showSettingsScreen(initFn) {
  document.getElementById("app-screen").style.display = "none";
  document.getElementById("onboarding-screen").style.display = "none";
  document.getElementById("settings-screen").style.display = "block";
  initFn();
}

// state = { basePath, watchPath, userModules, autoMoveEnabled, autoMoveThreshold,
//           notificationsEnabled, darkModeEnabled, classificationRules, notificationApi }
// callbacks = { onClose(), applyTheme() }
export function initSettings(state, callbacks) {
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
  const apiKeyInput = document.getElementById("settings-api-key");
  const toggleKeyBtn = document.getElementById("settings-toggle-key-btn");
  const apiKeyStatus = document.getElementById("api-key-status");
  const saveBtn = document.getElementById("settings-save-btn");
  const settingsStatus = document.getElementById("settings-status");

  // Auto-save helper - persists settings immediately
  function autoSaveSettings() {
    localStorage.setItem(STORAGE_KEYS.modules, JSON.stringify(state.userModules));
    localStorage.setItem(STORAGE_KEYS.basePath, state.basePath);
    localStorage.setItem(STORAGE_KEYS.watchPath, state.watchPath);
    localStorage.setItem(STORAGE_KEYS.autoMoveEnabled, String(state.autoMoveEnabled));
    localStorage.setItem(STORAGE_KEYS.autoMoveThreshold, String(state.autoMoveThreshold));
    localStorage.setItem(STORAGE_KEYS.notificationsEnabled, String(state.notificationsEnabled));
    localStorage.setItem(STORAGE_KEYS.theme, state.darkModeEnabled ? "dark" : "light");
  }

  // Populate current values (working directly with state object)
  basePathInput.value = state.basePath;
  watchPathInput.value = state.watchPath || "";
  notificationsToggle.checked = state.notificationsEnabled;
  notificationHint.style.display = "none";
  autoMoveToggle.checked = state.autoMoveEnabled;
  thresholdSlider.value = Math.round(state.autoMoveThreshold * 100);
  thresholdValue.textContent = Math.round(state.autoMoveThreshold * 100) + "%";
  thresholdGroup.style.display = state.autoMoveEnabled ? "block" : "none";
  darkModeToggle.checked = state.darkModeEnabled;
  // Load API key from secure Rust-side storage
  (async () => {
    try {
      const storedKey = await invoke("get_api_key");
      apiKeyInput.value = storedKey || "";
      apiKeyStatus.textContent = storedKey ? "Key saved securely" : "";
      apiKeyStatus.style.color = storedKey ? "var(--success)" : "";
    } catch (e) {
      apiKeyInput.value = "";
      apiKeyStatus.textContent = "";
    }
  })();

  // API key show/hide toggle
  toggleKeyBtn.addEventListener("click", () => {
    const isPassword = apiKeyInput.type === "password";
    apiKeyInput.type = isPassword ? "text" : "password";
    toggleKeyBtn.textContent = isPassword ? "Hide" : "Show";
  });

  // Save API key securely to Rust side on blur
  apiKeyInput.addEventListener("change", async () => {
    const val = apiKeyInput.value.trim();
    try {
      await invoke("set_api_key", { key: val });
      if (val) {
        apiKeyStatus.textContent = "Key saved securely";
        apiKeyStatus.style.color = "var(--success)";
      } else {
        apiKeyStatus.textContent = "No key set - AI classification will not work";
        apiKeyStatus.style.color = "var(--warning)";
      }
    } catch (e) {
      apiKeyStatus.textContent = "Failed to save key";
      apiKeyStatus.style.color = "var(--error)";
    }
  });

  renderSettingsModuleList();

  // Dark mode toggle - clone switch to remove old handlers
  const oldDarkModeSwitch = darkModeToggle.nextElementSibling;
  const darkModeSwitch = oldDarkModeSwitch.cloneNode(true);
  oldDarkModeSwitch.parentNode.replaceChild(darkModeSwitch, oldDarkModeSwitch);
  darkModeSwitch.addEventListener("click", function(e) {
    e.preventDefault();
    e.stopPropagation();
    darkModeToggle.checked = !darkModeToggle.checked;
    state.darkModeEnabled = darkModeToggle.checked;
    callbacks.applyTheme();
    autoSaveSettings();
  });

  // Helper to close settings and return to main app
  function closeSettings() {
    document.getElementById("settings-screen").style.display = "none";
    document.getElementById("app-screen").style.display = "block";
    callbacks.onClose();
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
    if (state.userModules.length === 0) {
      showSettingsStatus("Please add at least one module", "error");
      return;
    }
    if (!state.basePath) {
      showSettingsStatus("Please select an education folder", "error");
      return;
    }

    newSaveBtn.disabled = true;
    newSaveBtn.textContent = "Creating folders...";

    // Create any missing module folders
    for (const moduleName of state.userModules) {
      const folderPath = pathJoin(state.basePath, moduleName);
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
      if (selected && selected !== state.basePath) {
        state.basePath = selected;
        basePathInput.value = selected;
        // Clear modules - they belonged to the old folder
        state.userModules = [];
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
        state.watchPath = selected;
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
    if (!state.basePath) {
      showSettingsStatus("Please select your education folder first", "error");
      return;
    }
    newScanBtn.disabled = true;
    newScanBtn.textContent = "Scanning...";
    try {
      const folders = await invoke("scan_folders", { path: state.basePath, recursive: true });
      if (folders.length === 0) {
        showSettingsStatus("No subfolders found", "info");
      } else {
        state.userModules = folders;
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
      if (state.userModules.some(m => m.toLowerCase() === name.toLowerCase())) {
        showSettingsStatus("Module already exists", "error");
        return;
      }
      state.userModules.push(name);
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
  notificationsToggle.checked = state.notificationsEnabled;
  const oldNotifSwitch = notificationsToggle.nextElementSibling;
  const notifSwitch = oldNotifSwitch.cloneNode(true);
  oldNotifSwitch.parentNode.replaceChild(notifSwitch, oldNotifSwitch);
  notifSwitch.addEventListener("click", async function(e) {
    e.preventDefault();
    e.stopPropagation();

    const newState = !notificationsToggle.checked;
    notificationsToggle.checked = newState;
    state.notificationsEnabled = newState;

    if (newState && state.notificationApi) {
      try {
        const granted = await state.notificationApi.isPermissionGranted();
        if (!granted) {
          const permission = await state.notificationApi.requestPermission();
          if (permission !== "granted") {
            notificationsToggle.checked = false;
            state.notificationsEnabled = false;
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

  // Autostart toggle
  const autostartToggle = document.getElementById("settings-autostart-toggle");
  (async () => {
    try {
      autostartToggle.checked = await autostartIsEnabled();
    } catch (e) {
      autostartToggle.checked = false;
    }
  })();
  const oldAutostartSwitch = autostartToggle.nextElementSibling;
  const autostartSwitch = oldAutostartSwitch.cloneNode(true);
  oldAutostartSwitch.parentNode.replaceChild(autostartSwitch, oldAutostartSwitch);
  autostartSwitch.addEventListener("click", async function(e) {
    e.preventDefault();
    e.stopPropagation();
    const newState = !autostartToggle.checked;
    try {
      if (newState) {
        await autostartEnable();
      } else {
        await autostartDisable();
      }
      autostartToggle.checked = newState;
      showSettingsStatus(newState ? "Auto-start enabled" : "Auto-start disabled", "success");
    } catch (err) {
      showSettingsStatus("Failed to update auto-start: " + err, "error");
    }
  });

  // Auto-move toggle - clone switch to remove old handlers
  autoMoveToggle.checked = state.autoMoveEnabled;
  const oldAutoMoveSwitch = autoMoveToggle.nextElementSibling;
  const autoMoveSwitch = oldAutoMoveSwitch.cloneNode(true);
  oldAutoMoveSwitch.parentNode.replaceChild(autoMoveSwitch, oldAutoMoveSwitch);
  autoMoveSwitch.addEventListener("click", function(e) {
    e.preventDefault();
    e.stopPropagation();
    autoMoveToggle.checked = !autoMoveToggle.checked;
    state.autoMoveEnabled = autoMoveToggle.checked;
    thresholdGroup.style.display = state.autoMoveEnabled ? "block" : "none";
    autoSaveSettings();
  });

  // Threshold slider - use oninput to replace any existing handler
  thresholdSlider.value = Math.round(state.autoMoveThreshold * 100);
  thresholdSlider.oninput = function() {
    state.autoMoveThreshold = parseInt(this.value) / 100;
    thresholdValue.textContent = this.value + "%";
    autoSaveSettings();
  };

  function renderSettingsModuleList() {
    moduleList.innerHTML = "";
    state.userModules.forEach((name, index) => {
      const item = document.createElement("div");
      item.className = "module-item";
      item.innerHTML = `
        <span class="module-name">${escapeHtml(name)}</span>
        <button class="module-remove-btn" title="Remove module" aria-label="Remove module">&times;</button>
      `;
      item.querySelector(".module-remove-btn").addEventListener("click", () => {
        state.userModules.splice(index, 1);
        renderSettingsModuleList();
        autoSaveSettings();
      });
      moduleList.appendChild(item);
    });
  }

  // ---- Classification Rules UI ----
  const rulesList = document.getElementById("rules-list");
  const addRuleBtn = document.getElementById("add-rule-btn");
  const addRuleForm = document.getElementById("add-rule-form");
  const rulePatternInput = document.getElementById("rule-pattern-input");
  const ruleFolderSelect = document.getElementById("rule-folder-select");
  const ruleConfirmBtn = document.getElementById("rule-confirm-btn");
  const ruleCancelBtn = document.getElementById("rule-cancel-btn");

  function renderRulesList() {
    rulesList.innerHTML = "";
    if (state.classificationRules.length === 0) {
      rulesList.innerHTML = '<p class="empty-msg" style="margin:0;font-size:12px;">No rules yet</p>';
      return;
    }
    for (const rule of state.classificationRules) {
      const item = document.createElement("div");
      item.className = "rule-item";
      const folderName = pathBasename(rule.target_folder);
      item.innerHTML = `
        <span class="rule-pattern">${escapeHtml(rule.pattern)}</span>
        <span class="rule-arrow">\u2192</span>
        <span class="rule-folder" title="${escapeHtml(rule.target_folder)}">${escapeHtml(folderName)}</span>
        <button class="rule-delete-btn" title="Delete rule">&times;</button>
      `;
      item.querySelector(".rule-delete-btn").addEventListener("click", async () => {
        await dbDeleteRule(rule.id);
        state.classificationRules = state.classificationRules.filter(r => r.id !== rule.id);
        renderRulesList();
      });
      rulesList.appendChild(item);
    }
  }

  function populateRuleFolderSelect() {
    ruleFolderSelect.innerHTML = "";
    for (const name of state.userModules) {
      const opt = document.createElement("option");
      opt.value = pathJoin(state.basePath, name);
      opt.textContent = name;
      ruleFolderSelect.appendChild(opt);
    }
  }

  renderRulesList();

  const newAddRuleBtn = addRuleBtn.cloneNode(true);
  addRuleBtn.parentNode.replaceChild(newAddRuleBtn, addRuleBtn);
  newAddRuleBtn.addEventListener("click", () => {
    populateRuleFolderSelect();
    addRuleForm.style.display = "flex";
    newAddRuleBtn.style.display = "none";
    rulePatternInput.value = "";
    rulePatternInput.focus();
  });

  const newRuleConfirm = ruleConfirmBtn.cloneNode(true);
  ruleConfirmBtn.parentNode.replaceChild(newRuleConfirm, ruleConfirmBtn);
  newRuleConfirm.addEventListener("click", async () => {
    const pattern = rulePatternInput.value.trim();
    const targetFolder = ruleFolderSelect.value;
    if (!pattern) {
      showSettingsStatus("Please enter a pattern", "error");
      return;
    }
    if (!targetFolder) {
      showSettingsStatus("Please select a target folder", "error");
      return;
    }
    const id = await dbAddRule(pattern, targetFolder);
    if (id) {
      state.classificationRules.push({ id, pattern, target_folder: targetFolder });
      renderRulesList();
    }
    addRuleForm.style.display = "none";
    newAddRuleBtn.style.display = "block";
  });

  const newRuleCancel = ruleCancelBtn.cloneNode(true);
  ruleCancelBtn.parentNode.replaceChild(newRuleCancel, ruleCancelBtn);
  newRuleCancel.addEventListener("click", () => {
    addRuleForm.style.display = "none";
    newAddRuleBtn.style.display = "block";
  });

  rulePatternInput.onkeydown = (e) => {
    if (e.key === "Enter") newRuleConfirm.click();
    if (e.key === "Escape") {
      addRuleForm.style.display = "none";
      newAddRuleBtn.style.display = "block";
    }
  };

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
