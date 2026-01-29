"""
Path utility functions
"""
from pathlib import Path
import os


def normalize_path(path_str):
    """
    Normalize a path string
    
    Args:
        path_str: Path string to normalize
        
    Returns:
        Path: Normalized Path object
    """
    path = Path(path_str).expanduser()
    return path.resolve()


def ensure_directory_exists(directory):
    """
    Ensure a directory exists, creating it if necessary
    
    Args:
        directory: Directory path
        
    Returns:
        Path: Path object for the directory
    """
    path = Path(directory).expanduser()
    path.mkdir(parents=True, exist_ok=True)
    return path


def get_safe_filename(filename):
    """
    Convert a string to a safe filename
    
    Args:
        filename: Original filename
        
    Returns:
        str: Safe filename
    """
    # Remove or replace unsafe characters
    unsafe_chars = '<>:"/\\|?*'
    safe_name = filename
    
    for char in unsafe_chars:
        safe_name = safe_name.replace(char, '_')
    
    # Remove leading/trailing spaces and dots
    safe_name = safe_name.strip(' .')
    
    return safe_name


def get_relative_path(path, base):
    """
    Get relative path from base directory
    
    Args:
        path: Target path
        base: Base directory
        
    Returns:
        Path: Relative path
    """
    try:
        return Path(path).relative_to(base)
    except ValueError:
        # If paths are on different drives or not related
        return Path(path)


def is_hidden_file(path):
    """
    Check if a file is hidden
    
    Args:
        path: Path to check
        
    Returns:
        bool: True if file is hidden
    """
    path = Path(path)
    
    # Check if filename starts with dot (Unix-style hidden files)
    if path.name.startswith('.'):
        return True
    
    # Check Windows hidden attribute
    if os.name == 'nt':
        try:
            import ctypes
            attrs = ctypes.windll.kernel32.GetFileAttributesW(str(path))
            return attrs != -1 and attrs & 2  # FILE_ATTRIBUTE_HIDDEN
        except:
            pass
    
    return False
