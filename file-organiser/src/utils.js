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

// Get a file type icon (emoji) based on file extension
export function getFileTypeIcon(filename) {
  const ext = getFileExt(filename);
  const icons = {
    pdf: "\u{1F4C4}",
    doc: "\u{1F4DD}", docx: "\u{1F4DD}",
    ppt: "\u{1F4CA}", pptx: "\u{1F4CA}",
    xls: "\u{1F4C8}", xlsx: "\u{1F4C8}",
    png: "\u{1F5BC}\uFE0F", jpg: "\u{1F5BC}\uFE0F", jpeg: "\u{1F5BC}\uFE0F",
    gif: "\u{1F5BC}\uFE0F", webp: "\u{1F5BC}\uFE0F", bmp: "\u{1F5BC}\uFE0F",
    txt: "\u{1F4C3}", md: "\u{1F4C3}", csv: "\u{1F4C3}",
    zip: "\u{1F4E6}", rar: "\u{1F4E6}", "7z": "\u{1F4E6}",
    py: "\u{1F4BB}", js: "\u{1F4BB}", rs: "\u{1F4BB}",
    java: "\u{1F4BB}", cpp: "\u{1F4BB}", c: "\u{1F4BB}",
  };
  return icons[ext] || "\u{1F4CE}";
}

// Check cache: if we've classified this exact filename before and the user accepted/corrected it,
// return a synthetic classification result to skip the API call.
export function getCachedClassification(filename, correctionLog, userModules, basePath) {
  const cached = correctionLog.find(
    c => c.filename === filename && (c.type === "accepted" || c.type === "corrected")
  );
  if (!cached) return null;
  const folder = userModules.find(m => m.toLowerCase() === cached.userChose.toLowerCase());
  if (!folder) return null; // folder was deleted
  return {
    is_relevant: true,
    suggested_folder: pathJoin(basePath, folder),
    confidence: 1.0,
    reasoning: "Previously classified by you",
  };
}

// Match a filename against user-defined rules (glob patterns).
// Returns a synthetic classification result or null.
export function matchRule(filename, rules) {
  for (const rule of rules) {
    const regex = new RegExp("^" + rule.pattern.replace(/[.+^${}()|[\]]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
    if (regex.test(filename)) {
      return {
        is_relevant: true,
        suggested_folder: rule.target_folder,
        confidence: 1.0,
        reasoning: `Matched rule: ${rule.pattern}`,
      };
    }
  }
  return null;
}

// Cross-platform path join: detects separator from base path and joins parts.
// On Windows, basePath from Tauri dialogs uses backslashes; on macOS/Linux, forward slashes.
export function pathJoin(base, ...parts) {
  const sep = base.includes("\\") ? "\\" : "/";
  return [base, ...parts].filter(Boolean).join(sep);
}

// Cross-platform path basename: extracts the last component from a path.
// Handles both backslash (Windows) and forward slash (macOS/Linux).
export function pathBasename(filePath) {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || "";
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
