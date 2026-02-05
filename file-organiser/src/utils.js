// ============================================================
// PURE UTILITY FUNCTIONS
// ============================================================
// These functions have no side effects and don't depend on app state.
// They can be imported by both main.js and the test file.

import {
  IMAGE_EXTENSIONS,
  CONTENT_EXTRACTABLE_EXTENSIONS,
  RAPID_WINDOW_MS,
  BATCH_WINDOW_MS,
  MIN_BATCH_SIZE,
  MAX_MODULE_NAME_LENGTH,
  INVALID_FILENAME_CHARS,
} from "./constants.js";

export function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

export function escapeHtml(str) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(str).replace(/[&<>"']/g, (c) => map[c]);
}

export function getFileExt(filename) {
  return filename.split(".").pop().toLowerCase();
}

export function isImageFile(filename) {
  return IMAGE_EXTENSIONS.includes(getFileExt(filename));
}

export function isContentExtractable(filename) {
  return CONTENT_EXTRACTABLE_EXTENSIONS.includes(getFileExt(filename));
}

export function isToday(date) {
  const now = new Date();
  return (
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()
  );
}

export function shouldGroupAsBatch(files) {
  if (files.length === 1) return false;

  let isRapidFire = true;
  for (let i = 1; i < files.length; i++) {
    if (files[i].timestamp - files[i - 1].timestamp > RAPID_WINDOW_MS) {
      isRapidFire = false;
      break;
    }
  }
  if (isRapidFire) return true;

  if (files.length >= MIN_BATCH_SIZE) {
    const totalTimeSpan = files[files.length - 1].timestamp - files[0].timestamp;
    if (totalTimeSpan <= BATCH_WINDOW_MS) return true;
  }

  return false;
}

export function validateModuleName(name) {
  if (!name || name.trim().length === 0) {
    return "Module name cannot be empty";
  }
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return "Module name cannot contain path separators or '..'";
  }
  if (INVALID_FILENAME_CHARS.test(name)) {
    return 'Module name cannot contain < > : " | ? *';
  }
  if (/^\.+$/.test(name.trim())) {
    return "Module name cannot be just dots";
  }
  if (name.trim().length > MAX_MODULE_NAME_LENGTH) {
    return `Module name is too long (max ${MAX_MODULE_NAME_LENGTH} characters)`;
  }
  return null;
}

// Build correction history strings for the AI prompt
export function buildCorrectionHistory(correctionLog) {
  if (correctionLog.length === 0) return [];

  const recentCount = 20;
  const recent = correctionLog.slice(-recentCount);
  const older = correctionLog.slice(0, -recentCount);

  const lines = [];

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
    .map(
      ([folder, s]) =>
        `${folder}: ${Math.round((s.correct / s.total) * 100)}% accuracy (${s.correct}/${s.total})`
    )
    .join(", ");

  if (statsLines) {
    lines.push(`[Folder accuracy stats: ${statsLines}]`);
  }

  if (older.length > 0) {
    const olderCorrections = older.filter((c) => c.type === "corrected").length;
    const olderAccepted = older.filter((c) => c.type === "accepted").length;
    const olderDismissed = older.filter((c) => c.type === "dismissed").length;
    lines.push(
      `[Earlier history: ${olderAccepted} accepted, ${olderCorrections} corrected, ${olderDismissed} dismissed]`
    );
  }

  for (const c of recent) {
    if (c.type === "accepted") {
      lines.push(`"${c.filename}" → ${c.userChose} (correct)`);
    } else if (c.type === "corrected") {
      lines.push(
        `"${c.filename}" → AI suggested ${c.aiSuggested}, but user moved to ${c.userChose}`
      );
    } else if (c.type === "dismissed") {
      lines.push(`"${c.filename}" → User dismissed this file (didn't want to organize it)`);
    }
  }

  return lines;
}

// Filter out files already tracked in detected/skipped/ignored lists
export function filterNewFiles(scannedFiles, detectedFiles, skippedFiles, ignoredFiles) {
  const existingPaths = new Set([
    ...detectedFiles.map((f) => f.path),
    ...skippedFiles.map((f) => f.path),
    ...ignoredFiles.map((f) => f.path),
  ]);
  return scannedFiles.filter((f) => !existingPaths.has(f.path));
}
