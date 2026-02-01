"""
Download watcher that monitors specified directories for new files
"""
import time
import os
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler


class DownloadsHandler(FileSystemEventHandler):
    """Watches directories for new file events with debouncing"""

    def __init__(self, on_new_file_callback, debounce_seconds=2):
        """
        Initialize the downloads handler

        Args:
            on_new_file_callback: Function to call when a file is ready
            debounce_seconds: Seconds to wait for file stability
        """
        self.on_new_file_callback = on_new_file_callback
        self.debounce_seconds = debounce_seconds
        self._last_seen = {}  # Track when files were last modified
        self._sent_to_batch = set()  # Track files sent to batch (prevents re-processing)
    
    def on_created(self, event):
        """Handle file creation events - START tracking the file"""
        if event.is_directory:
            return

        file_path = event.src_path
        # Only add if not already tracking (prevent duplicate detection)
        if file_path not in self._last_seen:
            self._last_seen[file_path] = time.time()

    def on_modified(self, event):
        """Handle file modification events - UPDATE the timestamp"""
        if event.is_directory:
            return

        file_path = event.src_path
        # Only update timestamp if already tracking (don't re-add completed files)
        if file_path in self._last_seen:
            self._last_seen[file_path] = time.time()
        # File is still being written, keep updating the timestamp
    
    def process_ready_files(self):
        """
        Check which files have stopped changing and are ready to process.
        This runs every second to check if any tracked files are stable.
        """
        now = time.time()
        ready_files = []

        # Check all tracked files to see if they're ready
        for file_path, last_time in list(self._last_seen.items()):
            # If file hasn't changed for debounce_seconds, it's ready
            if now - last_time >= self.debounce_seconds:
                if os.path.exists(file_path):
                    ready_files.append(file_path)
                # Remove from tracking regardless
                del self._last_seen[file_path]

        # Process all ready files
        for file_path in ready_files:
            # Mark as sent to batch IMMEDIATELY (prevents re-detection)
            self._sent_to_batch.add(file_path)
            self.on_new_file_callback(file_path)


def start_downloads_watcher(downloads_path, on_new_file_callback, on_batch_callback=None, batch_manager=None, retry_callback=None, processing_state=None):
    """
    Start watching a directory for new files

    Args:
        downloads_path: Path to the directory to watch
        on_new_file_callback: Function to call when a new file is ready
        on_batch_callback: Function to call when batch is ready
        batch_manager: BatchManager instance
        retry_callback: Function to call to process locked file retries
        processing_state: ProcessingState instance for coordinating user input
    """
    event_handler = DownloadsHandler(on_new_file_callback)
    observer = Observer()
    observer.schedule(event_handler, downloads_path, recursive=False)
    observer.start()

    # Track files we've already processed (prevents re-processing opened files)
    processed_files = set()
    last_scan = 0
    RECENT_WINDOW = 60  # Only consider files CREATED in last 60 seconds (1 minute)

    try:
        while True:
            event_handler.process_ready_files()

            # Check if we should pause processing while user is typing
            # This prevents confusing interleaved messages (standard CLI behavior)
            if processing_state and processing_state.is_paused():
                time.sleep(0.1)  # Brief sleep, then check again
                continue

            # Periodic file scan (every 3 seconds) to catch files watchdog misses
            # This is especially important on OneDrive/network drives
            now = time.time()
            if now - last_scan >= 3:
                last_scan = now
                try:
                    for file in os.listdir(downloads_path):
                        file_path = os.path.join(downloads_path, file)
                        # Skip if already processed OR already sent to batch
                        if os.path.isfile(file_path) and file_path not in processed_files and file_path not in event_handler._sent_to_batch:
                            # Check if file is "new" (CREATED within last 60 seconds, not just modified)
                            # This prevents re-processing files that were merely opened/viewed
                            try:
                                ctime = os.path.getctime(file_path)  # Creation time on Windows
                                if now - ctime <= RECENT_WINDOW:
                                    # Only add if NOT already tracking (CRITICAL: prevents duplicate detection!)
                                    if file_path not in event_handler._last_seen:
                                        event_handler._last_seen[file_path] = time.time()
                            except:
                                pass  # Skip files that can't be stat'd
                except Exception as e:
                    pass  # Silently ignore scan errors

            if batch_manager and on_batch_callback and batch_manager.is_ready():
                batch = batch_manager.pop_batch()
                # Mark all files in batch as processed
                for file_path in batch:
                    processed_files.add(file_path)
                    # Also remove from sent_to_batch (cleanup)
                    event_handler._sent_to_batch.discard(file_path)
                on_batch_callback(batch)

            # Process locked file retries
            if retry_callback:
                retry_callback()

            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()

    observer.join()
