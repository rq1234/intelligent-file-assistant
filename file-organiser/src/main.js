const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open } = window.__TAURI__.dialog;

// State
let watchPath = "";
let detectedFiles = [];
let isWatching = false;

// DOM Elements
let watchPathInput;
let selectFolderBtn;
let startWatchingBtn;
let statusMsg;
let fileList;
let fileCount;

// Initialize when DOM is loaded
window.addEventListener("DOMContentLoaded", () => {
  // Get DOM elements
  watchPathInput = document.querySelector("#watch-path");
  selectFolderBtn = document.querySelector("#select-folder-btn");
  startWatchingBtn = document.querySelector("#start-watching-btn");
  statusMsg = document.querySelector("#status-msg");
  fileList = document.querySelector("#file-list");
  fileCount = document.querySelector("#file-count");

  // Set up event listeners
  selectFolderBtn.addEventListener("click", selectFolder);
  startWatchingBtn.addEventListener("click", startWatching);

  // Listen for file detection events from Rust
  setupFileListener();

  // Auto-select Downloads folder
  const downloads = "C:\\Users\\rongq\\Downloads";  // Update with your path
  watchPathInput.value = downloads;
  watchPath = downloads;
  startWatchingBtn.disabled = false;
  showStatus("Ready to watch Downloads folder", "info");
});

// Open folder picker dialog
async function selectFolder() {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select folder to watch",
    });

    if (selected) {
      watchPath = selected;
      watchPathInput.value = selected;
      startWatchingBtn.disabled = false;
      showStatus("Folder selected", "success");
    }
  } catch (error) {
    showStatus(`Error selecting folder: ${error}`, "error");
  }
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
    // Call Rust command to start watching
    await invoke("start_watching", { path: watchPath });

    isWatching = true;
    startWatchingBtn.textContent = "Watching...";
    startWatchingBtn.disabled = true;
    selectFolderBtn.disabled = true;

    showStatus(`✓ Watching ${watchPath}`, "success");
  } catch (error) {
    showStatus(`Failed to start watching: ${error}`, "error");
  }
}

// Set up listener for file detection events from Rust
function setupFileListener() {
  listen("file-detected", (event) => {
    const fileInfo = event.payload;
    console.log("File detected:", fileInfo);

    // Add to detected files list
    addDetectedFile(fileInfo);
  });
}

// Add a detected file to the UI
function addDetectedFile(fileInfo) {
  // Add to array
  detectedFiles.push(fileInfo);

  // Update count
  fileCount.textContent = detectedFiles.length;

  // Remove empty message if it exists
  const emptyMsg = fileList.querySelector(".empty-msg");
  if (emptyMsg) {
    emptyMsg.remove();
  }

  // Create file item element
  const fileItem = document.createElement("div");
  fileItem.className = "file-item";
  fileItem.innerHTML = `
    <div class="file-info">
      <strong>${fileInfo.name}</strong>
      <small>${formatFileSize(fileInfo.size)}</small>
    </div>
    <div class="file-path">
      <span>${fileInfo.path}</span>
    </div>
  `;

  // Add to list (newest first)
  fileList.insertBefore(fileItem, fileList.firstChild);

  // Show notification
  showStatus(`New file detected: ${fileInfo.name}`, "success");
}

// Format file size for display
function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
}

// Show status message
function showStatus(message, type = "info") {
  statusMsg.textContent = message;
  statusMsg.className = `status-msg ${type}`;

  // Auto-clear after 5 seconds
  setTimeout(() => {
    if (statusMsg.textContent === message) {
      statusMsg.textContent = "";
      statusMsg.className = "status-msg";
    }
  }, 5000);
}
