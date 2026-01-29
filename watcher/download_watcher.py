"""
Download watcher that monitors specified directories for new files
"""
import time
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler


class DownloadWatcher(FileSystemEventHandler):
    """Watches directories for new file events"""
    
    def __init__(self, matcher, settings):
        """
        Initialize the download watcher
        
        Args:
            matcher: FileMatcher instance to process new files
            settings: Configuration settings
        """
        self.matcher = matcher
        self.settings = settings
        self.observer = Observer()
        self.watch_dirs = settings.get('watch_directories', [])
        
    def start(self):
        """Start watching the configured directories"""
        for watch_dir in self.watch_dirs:
            path = Path(watch_dir).expanduser()
            if path.exists():
                self.observer.schedule(self, str(path), recursive=False)
                print(f"Watching directory: {path}")
            else:
                print(f"Warning: Directory does not exist: {path}")
        
        self.observer.start()
    
    def stop(self):
        """Stop watching directories"""
        self.observer.stop()
        self.observer.join()
    
    def join(self):
        """Wait for the observer thread"""
        try:
            while self.observer.is_alive():
                time.sleep(1)
        except KeyboardInterrupt:
            self.stop()
    
    def on_created(self, event):
        """Handle file creation events"""
        if not event.is_directory:
            file_path = Path(event.src_path)
            print(f"New file detected: {file_path}")
            
            # Wait for file to finish writing
            delay = self.settings.get('processing', {}).get('delay_seconds', 5)
            time.sleep(delay)
            
            # Process the file
            self.matcher.process_file(file_path)
    
    def on_modified(self, event):
        """Handle file modification events"""
        # Can be implemented if needed
        pass
