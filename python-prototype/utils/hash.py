# utils/hash.py
"""
File hashing utility for duplicate detection
"""
import hashlib


def file_hash(path, chunk_size=8192):
    """
    Calculate SHA-256 hash of a file
    
    Args:
        path: Path to file
        chunk_size: Size of chunks to read
        
    Returns:
        str: Hexadecimal hash digest
    """
    h = hashlib.sha256()
    
    with open(path, "rb") as f:
        while chunk := f.read(chunk_size):
            h.update(chunk)
    
    return h.hexdigest()
