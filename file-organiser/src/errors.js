// ============================================================
// ERROR HANDLING UTILITIES
// ============================================================
// Extract and classify Tauri command errors.

// Extract error message string from Tauri command errors.
// Rust CommandError serializes as {type: "FileInUse", message: "..."} via serde.
// Tauri may also pass errors as plain strings or other formats.
export function getErrorMessage(error) {
  if (typeof error === "string") {
    // Could be a JSON string — try parsing
    try {
      const parsed = JSON.parse(error);
      if (parsed && typeof parsed === "object") {
        const msg = parsed.message || parsed.msg || "";
        const type = parsed.type || "";
        return (type + " " + msg).toLowerCase();
      }
    } catch (_) { /* not JSON, use as-is */ }
    return error.toLowerCase();
  }
  if (error && typeof error === "object") {
    const msg = error.message || error.msg || "";
    const type = error.type || "";
    return (type + " " + msg).toLowerCase();
  }
  return String(error).toLowerCase();
}

export function isLockedFileError(error) {
  const msg = getErrorMessage(error);
  return msg.includes("fileinuse") || msg.includes("file_in_use") ||
    msg.includes("used by another process") || msg.includes("being used") ||
    msg.includes("permission denied") || msg.includes("access denied") ||
    msg.includes("permissiondenied") || msg.includes("os error 32");
}

export function isDuplicateError(error) {
  const msg = getErrorMessage(error);
  return msg.includes("duplicateexists") || msg.includes("duplicate_exists") ||
    msg.includes("file already exists") || msg.includes("already exists");
}
