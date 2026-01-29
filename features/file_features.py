"""
Extract features from files for classification
"""
import os
from pathlib import Path
from datetime import datetime


def extract_file_features(file_path):
    """
    Extract various features from a file
    
    Args:
        file_path: Path to the file
        
    Returns:
        dict: Dictionary of file features
    """
    path = Path(file_path)
    
    features = {
        'name': path.name,
        'stem': path.stem,
        'extension': path.suffix.lower().lstrip('.'),
        'size': path.stat().st_size if path.exists() else 0,
        'created': datetime.fromtimestamp(path.stat().st_ctime) if path.exists() else None,
        'modified': datetime.fromtimestamp(path.stat().st_mtime) if path.exists() else None,
        'parent_dir': path.parent.name,
    }
    
    return features


def get_file_category(extension):
    """
    Get the general category of a file based on its extension
    
    Args:
        extension: File extension without dot
        
    Returns:
        str: Category name
    """
    categories = {
        'document': ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt'],
        'image': ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'],
        'video': ['mp4', 'avi', 'mov', 'mkv', 'wmv', 'flv'],
        'audio': ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'wma'],
        'archive': ['zip', 'rar', 'tar', 'gz', '7z', 'bz2'],
        'code': ['py', 'js', 'html', 'css', 'java', 'cpp', 'c', 'h'],
        'spreadsheet': ['xls', 'xlsx', 'csv', 'ods'],
        'presentation': ['ppt', 'pptx', 'odp'],
    }
    
    for category, extensions in categories.items():
        if extension in extensions:
            return category
    
    return 'other'
