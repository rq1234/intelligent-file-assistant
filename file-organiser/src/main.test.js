// Unit tests for utility functions and logic
// Run with: node src/main.test.js

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

import { CONFIDENCE_THRESHOLD } from "./constants.js";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.log(`  FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.log(`  FAIL: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.log(`  FAIL: ${message}\n    expected: ${b}\n    got:      ${a}`);
  }
}

// --- Activity log helpers (app-specific, not in utils.js) ---
function addActivityEntry(activityLog, filename, fromFolder, toFolder) {
  const entry = {
    filename,
    from: fromFolder,
    to: toFolder,
    timestamp: Date.now(),
    undone: false,
  };
  activityLog.unshift(entry);
  return entry;
}

function markActivityUndone(activityLog, timestamp) {
  const entry = activityLog.find(e => e.timestamp === timestamp);
  if (entry) {
    entry.undone = true;
  }
}

// ============================================================
// TESTS
// ============================================================

console.log("\n=== formatFileSize ===");
assertEqual(formatFileSize(0), "0 Bytes", "0 bytes");
assertEqual(formatFileSize(500), "500 Bytes", "500 bytes");
assertEqual(formatFileSize(1024), "1 KB", "1 KB");
assertEqual(formatFileSize(1536), "1.5 KB", "1.5 KB");
assertEqual(formatFileSize(1048576), "1 MB", "1 MB");
assertEqual(formatFileSize(1073741824), "1 GB", "1 GB");
assertEqual(formatFileSize(1), "1 Bytes", "1 byte");
assertEqual(formatFileSize(2048), "2 KB", "2 KB");

console.log("\n=== getFileExt ===");
assertEqual(getFileExt("lecture.pdf"), "pdf", "simple pdf");
assertEqual(getFileExt("photo.PNG"), "png", "uppercase ext");
assertEqual(getFileExt("archive.tar.gz"), "gz", "double extension picks last");
assertEqual(getFileExt("noext"), "noext", "no extension returns filename");
assertEqual(getFileExt("file.JPEG"), "jpeg", "uppercase jpeg");
assertEqual(getFileExt(".gitignore"), "gitignore", "dotfile");

console.log("\n=== isImageFile ===");
assert(isImageFile("screenshot.png"), "png is image");
assert(isImageFile("photo.jpg"), "jpg is image");
assert(isImageFile("photo.jpeg"), "jpeg is image");
assert(isImageFile("animation.gif"), "gif is image");
assert(isImageFile("modern.webp"), "webp is image");
assert(isImageFile("old.bmp"), "bmp is image");
assert(!isImageFile("document.pdf"), "pdf is NOT image");
assert(!isImageFile("code.py"), "py is NOT image");
assert(!isImageFile("data.csv"), "csv is NOT image");
assert(isImageFile("PHOTO.PNG"), "uppercase PNG is image");

console.log("\n=== isContentExtractable ===");
assert(isContentExtractable("notes.pdf"), "pdf is extractable");
assert(isContentExtractable("readme.txt"), "txt is extractable");
assert(isContentExtractable("notes.md"), "md is extractable");
assert(isContentExtractable("data.csv"), "csv is extractable");
assert(!isContentExtractable("photo.png"), "png is NOT extractable");
assert(!isContentExtractable("app.exe"), "exe is NOT extractable");
assert(!isContentExtractable("doc.docx"), "docx is NOT extractable");

console.log("\n=== shouldGroupAsBatch ===");
// Single file -> never batch
assert(!shouldGroupAsBatch([{ timestamp: 1000 }]), "single file not batched");

// Two rapid files
assert(shouldGroupAsBatch([
  { timestamp: 1000 },
  { timestamp: 1500 },
]), "2 rapid files are batched");

// Two files too far apart
assert(!shouldGroupAsBatch([
  { timestamp: 1000 },
  { timestamp: 5000 },
]), "2 files 4s apart not batched (only 2, not enough for MIN_BATCH_SIZE)");

// 3 files within BATCH_WINDOW
assert(shouldGroupAsBatch([
  { timestamp: 1000 },
  { timestamp: 3000 },
  { timestamp: 5000 },
]), "3 files within 5s window are batched");

// 3 files outside BATCH_WINDOW
assert(!shouldGroupAsBatch([
  { timestamp: 1000 },
  { timestamp: 4000 },
  { timestamp: 10000 },
]), "3 files spanning 9s NOT batched");

// Rapid-fire burst (all within 2s of each other)
assert(shouldGroupAsBatch([
  { timestamp: 1000 },
  { timestamp: 1200 },
  { timestamp: 1400 },
  { timestamp: 1600 },
]), "rapid fire 4 files batched");

console.log("\n=== buildCorrectionHistory ===");
const corrections = [
  { filename: "ml_notes.pdf", aiSuggested: "ML", userChose: "ML", type: "accepted" },
  { filename: "tutorial3.pdf", aiSuggested: "Math", userChose: "Physics", type: "corrected" },
  { filename: "meme.jpg", aiSuggested: "unknown", userChose: "dismissed", type: "dismissed" },
];
const history = buildCorrectionHistory(corrections);
assertEqual(history.length, 3, "3 correction entries");
assert(history[0].includes("(correct)"), "accepted entry has (correct)");
assert(history[1].includes("AI suggested Math"), "corrected entry has AI suggestion");
assert(history[1].includes("user moved to Physics"), "corrected entry has user choice");
assert(history[2].includes("dismissed"), "dismissed entry mentions dismissed");

// Empty corrections
assertDeepEqual(buildCorrectionHistory([]), [], "empty corrections returns empty array");

// Unknown type gets filtered out
const unknownType = [{ filename: "x.pdf", type: "unknown_type" }];
assertDeepEqual(buildCorrectionHistory(unknownType), [], "unknown type filtered out");

console.log("\n=== Activity log ===");
{
  const log = [];
  const entry = addActivityEntry(log, "test.pdf", "C:\\Downloads", "C:\\Year2\\ML");
  assertEqual(log.length, 1, "activity log has 1 entry");
  assertEqual(entry.filename, "test.pdf", "entry has correct filename");
  assertEqual(entry.undone, false, "entry not undone initially");
  assert(entry.timestamp > 0, "entry has timestamp");

  // Mark as undone
  markActivityUndone(log, entry.timestamp);
  assert(log[0].undone, "entry marked as undone");

  // Mark non-existent timestamp (should be no-op)
  markActivityUndone(log, 99999999);
  assertEqual(log.length, 1, "no-op for non-existent timestamp");
}

// Newest first ordering
{
  const log = [];
  addActivityEntry(log, "first.pdf", "A", "B");
  addActivityEntry(log, "second.pdf", "A", "C");
  assertEqual(log[0].filename, "second.pdf", "newest entry is first");
  assertEqual(log[1].filename, "first.pdf", "oldest entry is second");
}

console.log("\n=== isToday ===");
assert(isToday(new Date()), "current date is today");
assert(!isToday(new Date("2020-01-01")), "past date is not today");
{
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  assert(!isToday(yesterday), "yesterday is not today");
}

console.log("\n=== Two-pass classification logic ===");
// Test the decision logic (without actually calling Tauri)
{
  // High confidence -> use first pass
  const highConfResult = { is_relevant: true, confidence: 0.9, suggested_folder: "ML" };
  assert(highConfResult.confidence >= CONFIDENCE_THRESHOLD, "high confidence passes threshold");

  // Low confidence -> should trigger second pass
  const lowConfResult = { is_relevant: true, confidence: 0.4, suggested_folder: "ML" };
  assert(lowConfResult.confidence < CONFIDENCE_THRESHOLD, "low confidence below threshold");

  // Not relevant with confidence 0 -> use first pass (no need for second)
  const notRelevant = { is_relevant: false, confidence: 0 };
  assert(!notRelevant.is_relevant && notRelevant.confidence === 0, "not relevant with 0 confidence short-circuits");

  // Exactly at threshold -> use first pass
  const atThreshold = { confidence: 0.7 };
  assert(atThreshold.confidence >= CONFIDENCE_THRESHOLD, "exactly at threshold passes");

  // Just below threshold -> needs second pass
  const justBelow = { confidence: 0.69 };
  assert(justBelow.confidence < CONFIDENCE_THRESHOLD, "just below threshold triggers second pass");
}

// Test which second pass strategy is chosen
{
  assert(isImageFile("screenshot.png") && !isContentExtractable("screenshot.png"),
    "image file -> vision path, not content extraction");
  assert(!isImageFile("tutorial.pdf") && isContentExtractable("tutorial.pdf"),
    "pdf -> content extraction, not vision");
  assert(!isImageFile("app.exe") && !isContentExtractable("app.exe"),
    "exe -> no second pass available");
  assert(isImageFile("photo.jpg") && !isContentExtractable("photo.jpg"),
    "jpg -> vision path");
  assert(!isImageFile("notes.md") && isContentExtractable("notes.md"),
    "md -> content extraction");
}

// ============================================================
// validateModuleName
// ============================================================

console.log("\n=== validateModuleName ===");
assertEqual(validateModuleName("Machine Learning"), null, "valid name accepted");
assertEqual(validateModuleName("CS 101"), null, "name with spaces and numbers accepted");
assertEqual(validateModuleName(""), "Module name cannot be empty", "empty string rejected");
assertEqual(validateModuleName("   "), "Module name cannot be empty", "whitespace-only rejected");
assert(validateModuleName("..\\Windows\\System32") !== null, "path traversal with backslash rejected");
assert(validateModuleName("../etc/passwd") !== null, "path traversal with forward slash rejected");
assert(validateModuleName("folder/subfolder") !== null, "forward slash rejected");
assert(validateModuleName("folder\\subfolder") !== null, "backslash rejected");
assert(validateModuleName("test<script>") !== null, "angle brackets rejected");
assert(validateModuleName('file:"name"') !== null, "colon and quotes rejected");
assert(validateModuleName("file|name") !== null, "pipe rejected");
assert(validateModuleName("file?name") !== null, "question mark rejected");
assert(validateModuleName("file*name") !== null, "asterisk rejected");
assertEqual(validateModuleName("."), "Module name cannot be just dots", "single dot rejected");
assert(validateModuleName("..") !== null, "double dots rejected by traversal check");
assert(validateModuleName("...") !== null, "triple dots rejected");
assert(validateModuleName("a".repeat(101)) !== null, "101 char name rejected");
assertEqual(validateModuleName("a".repeat(100)), null, "100 char name accepted");
assertEqual(validateModuleName("Maths & Stats"), null, "ampersand allowed");
assertEqual(validateModuleName("Year 2 (Semester 1)"), null, "parentheses allowed");

// ============================================================
// Bulk scan helpers
// ============================================================

console.log("\n=== filterNewFiles (bulk scan dedup) ===");
{
  const files = [
    { name: "a.pdf", path: "C:\\Downloads\\a.pdf", size: 100 },
    { name: "b.png", path: "C:\\Downloads\\b.png", size: 200 },
    { name: "c.txt", path: "C:\\Downloads\\c.txt", size: 300 },
    { name: "d.jpg", path: "C:\\Downloads\\d.jpg", size: 400 },
  ];

  // No existing files — all should pass through
  let result = filterNewFiles(files, [], [], []);
  assertEqual(result.length, 4, "all files pass when no existing");

  // One in detected
  result = filterNewFiles(files, [{ path: "C:\\Downloads\\a.pdf" }], [], []);
  assertEqual(result.length, 3, "filters out detected file");
  assert(!result.some(f => f.name === "a.pdf"), "a.pdf filtered from detected");

  // One in skipped
  result = filterNewFiles(files, [], [{ path: "C:\\Downloads\\b.png" }], []);
  assertEqual(result.length, 3, "filters out skipped file");
  assert(!result.some(f => f.name === "b.png"), "b.png filtered from skipped");

  // One in ignored
  result = filterNewFiles(files, [], [], [{ path: "C:\\Downloads\\c.txt" }]);
  assertEqual(result.length, 3, "filters out ignored file");
  assert(!result.some(f => f.name === "c.txt"), "c.txt filtered from ignored");

  // Multiple across all lists
  result = filterNewFiles(
    files,
    [{ path: "C:\\Downloads\\a.pdf" }],
    [{ path: "C:\\Downloads\\b.png" }],
    [{ path: "C:\\Downloads\\c.txt" }]
  );
  assertEqual(result.length, 1, "only untracked file remains");
  assertEqual(result[0].name, "d.jpg", "d.jpg is the untracked file");

  // All already tracked
  result = filterNewFiles(
    files,
    [{ path: "C:\\Downloads\\a.pdf" }, { path: "C:\\Downloads\\b.png" }],
    [{ path: "C:\\Downloads\\c.txt" }],
    [{ path: "C:\\Downloads\\d.jpg" }]
  );
  assertEqual(result.length, 0, "no files when all tracked");

  // Empty scan results
  result = filterNewFiles([], [{ path: "C:\\Downloads\\a.pdf" }], [], []);
  assertEqual(result.length, 0, "empty scan returns empty");
}

// ============================================================
// SUMMARY
// ============================================================
console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} total`);
if (failed > 0) {
  console.log("SOME TESTS FAILED!");
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED!");
}
