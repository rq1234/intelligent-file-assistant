// ============================================================
// ONBOARDING SCREEN
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { STORAGE_KEYS, ONBOARDING_STATUS_TIMEOUT_MS } from "./constants.js";
import { validateModuleName, escapeHtml, pathJoin } from "./utils.js";

export function showOnboardingScreen(initFn) {
  document.getElementById("onboarding-screen").style.display = "block";
  document.getElementById("app-screen").style.display = "none";
  document.getElementById("settings-screen").style.display = "none";
  initFn();
}

// state = { userModules: [...], basePath: "..." }
// callbacks = { onComplete() }
export function initOnboarding(state, callbacks) {
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
    state.basePath = savedBasePath;
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
      if (selected && selected !== state.basePath) {
        state.basePath = selected;
        basePathInput.value = selected;
        // Clear modules - they belonged to the old folder
        state.userModules = [];
        renderModuleList();
        localStorage.setItem(STORAGE_KEYS.basePath, selected);
        localStorage.setItem(STORAGE_KEYS.modules, JSON.stringify(state.userModules));
        showOnboardingStatus("Folder set - click 'Scan' to detect modules", "info");
        updateContinueBtn();
      }
    } catch (error) {
      showOnboardingStatus(`Error: ${error}`, "error");
    }
  });

  // --- Scan existing folders ---
  scanFoldersBtn.addEventListener("click", async () => {
    if (!state.basePath) {
      showOnboardingStatus("Please select your education folder first (Browse button below)", "error");
      return;
    }

    scanFoldersBtn.disabled = true;
    scanFoldersBtn.textContent = "Scanning...";

    try {
      const folders = await invoke("scan_folders", { path: state.basePath, recursive: true });

      if (folders.length === 0) {
        showOnboardingStatus("No subfolders found in that directory", "info");
      } else {
        // Replace current module list with scanned folders
        state.userModules = folders;
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
      if (state.userModules.some(m => m.toLowerCase() === name.toLowerCase())) {
        showOnboardingStatus("Module already exists", "error");
        return;
      }
      state.userModules.push(name);
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
    if (state.userModules.length === 0 || !state.basePath) return;

    continueBtn.disabled = true;
    continueBtn.textContent = "Setting up...";

    // Create any missing folders
    for (const moduleName of state.userModules) {
      const folderPath = pathJoin(state.basePath, moduleName);
      try {
        await invoke("create_folder", { path: folderPath });
      } catch (error) {
        console.error(`Failed to create folder for ${moduleName}:`, error);
      }
    }

    // Save to localStorage
    localStorage.setItem(STORAGE_KEYS.modules, JSON.stringify(state.userModules));
    localStorage.setItem(STORAGE_KEYS.basePath, state.basePath);
    localStorage.setItem(STORAGE_KEYS.onboarded, "true");

    // Switch to main app
    callbacks.onComplete();
  });

  // Initial render
  renderModuleList();
  updateContinueBtn();

  // --- Helper: render module list ---
  function renderModuleList() {
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
        renderModuleList();
        updateContinueBtn();
      });
      moduleList.appendChild(item);
    });
  }

  // --- Helper: update continue button state ---
  function updateContinueBtn() {
    continueBtn.disabled = state.userModules.length === 0 || !state.basePath;
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
