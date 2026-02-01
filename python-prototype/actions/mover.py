import os
from utils.hash import file_hash
from storage.local_store import save_undo_history


def is_duplicate(src, dst_folder):
    """
    Check if file already exists in destination folder
    
    Args:
        src: Source file path
        dst_folder: Destination folder path
        
    Returns:
        tuple: (bool, str or None) - (is_duplicate, existing_file_path)
    """
    filename = os.path.basename(src)
    dst_path = os.path.join(dst_folder, filename)
    
    # 1. Exact filename exists?
    if not os.path.exists(dst_path):
        return False, None
    
    # 2. If yes — check content similarity
    # Compare file hashes
    return file_hash(src) == file_hash(dst_path), dst_path

def move_file(src, folder):
    """
    Move file to destination folder
    
    Returns:
        tuple: (success: bool, error_type: str or None)
        error_types: 'locked', 'duplicate', 'other'
    """
    # Check for duplicates before moving
    is_dup, existing_path = is_duplicate(src, folder)
    if is_dup:
        print(f"⚠️  Duplicate detected! File already exists: {existing_path}")
        print(f"Skipping move.")
        return False, 'duplicate'
    
    # Normalize paths to use consistent separators
    folder = os.path.normpath(folder)
    os.makedirs(folder, exist_ok=True)
    dst = os.path.join(folder, os.path.basename(src))
    
    try:
        os.rename(src, dst)
        save_undo_history(src, dst)
        print(f"✓ Moved to {dst}")
        return True, None
    except PermissionError:
        print(f"⚠️  File locked - '{os.path.basename(src)}' is open in another program")
        return False, 'locked'
    except Exception as e:
        print(f"⚠️  Error moving file: {e}")
        return False, 'other'
