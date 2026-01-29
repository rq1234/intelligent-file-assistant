"""
File moving and copying operations
"""
import shutil
from pathlib import Path
from datetime import datetime


def move_file(source_path, target_path, store=None):
    """
    Move a file from source to target location
    
    Args:
        source_path: Source file path
        target_path: Target file path
        store: LocalStore instance for recording the action
        
    Returns:
        bool: True if successful, False otherwise
    """
    try:
        source = Path(source_path)
        target = Path(target_path)
        
        if not source.exists():
            print(f"Source file does not exist: {source}")
            return False
        
        # Create target directory if it doesn't exist
        target.parent.mkdir(parents=True, exist_ok=True)
        
        # Handle duplicate filenames
        if target.exists():
            target = get_unique_filename(target)
        
        # Move the file
        shutil.move(str(source), str(target))
        
        # Record the action for undo functionality
        if store:
            store.record_action({
                'type': 'move',
                'source': str(source),
                'target': str(target),
                'timestamp': datetime.now().isoformat()
            })
        
        return True
        
    except Exception as e:
        print(f"Error moving file: {e}")
        return False


def copy_file(source_path, target_path, store=None):
    """
    Copy a file from source to target location
    
    Args:
        source_path: Source file path
        target_path: Target file path
        store: LocalStore instance for recording the action
        
    Returns:
        bool: True if successful, False otherwise
    """
    try:
        source = Path(source_path)
        target = Path(target_path)
        
        if not source.exists():
            print(f"Source file does not exist: {source}")
            return False
        
        # Create target directory if it doesn't exist
        target.parent.mkdir(parents=True, exist_ok=True)
        
        # Handle duplicate filenames
        if target.exists():
            target = get_unique_filename(target)
        
        # Copy the file
        shutil.copy2(str(source), str(target))
        
        # Record the action
        if store:
            store.record_action({
                'type': 'copy',
                'source': str(source),
                'target': str(target),
                'timestamp': datetime.now().isoformat()
            })
        
        return True
        
    except Exception as e:
        print(f"Error copying file: {e}")
        return False


def get_unique_filename(file_path):
    """
    Generate a unique filename if the file already exists
    
    Args:
        file_path: Path object
        
    Returns:
        Path: Unique file path
    """
    path = Path(file_path)
    counter = 1
    
    while path.exists():
        new_name = f"{path.stem}_{counter}{path.suffix}"
        path = path.parent / new_name
        counter += 1
    
    return path
