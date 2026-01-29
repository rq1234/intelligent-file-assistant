"""
Main entry point for the File Organiser AI
"""
import sys
from pathlib import Path

from watcher.download_watcher import DownloadWatcher
from agent.matcher import FileMatcher
from agent.decision import DecisionEngine
from storage.local_store import LocalStore
from config.settings import load_settings


def main():
    """Main function to run the file organiser"""
    print("Starting File Organiser AI...")
    
    # Load configuration
    settings = load_settings()
    
    # Initialize components
    store = LocalStore()
    decision_engine = DecisionEngine(settings)
    matcher = FileMatcher(decision_engine, store)
    watcher = DownloadWatcher(matcher, settings)
    
    # Start watching
    try:
        watcher.start()
        print("File organiser is now running. Press Ctrl+C to stop.")
        watcher.join()
    except KeyboardInterrupt:
        print("\nStopping File Organiser AI...")
        watcher.stop()
        sys.exit(0)


if __name__ == "__main__":
    main()
