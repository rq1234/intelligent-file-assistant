"""
Content extraction utilities for different file types
"""
from pathlib import Path


def extract_text_content(file_path, max_length=1000):
    """
    Extract text content from a file
    
    Args:
        file_path: Path to the file
        max_length: Maximum length of text to extract
        
    Returns:
        str: Extracted text content
    """
    path = Path(file_path)
    extension = path.suffix.lower().lstrip('.')
    
    try:
        if extension in ['txt', 'md', 'log', 'csv']:
            return extract_plain_text(path, max_length)
        elif extension in ['pdf']:
            return extract_pdf_text(path, max_length)
        elif extension in ['doc', 'docx']:
            return extract_doc_text(path, max_length)
        else:
            return ""
    except Exception as e:
        print(f"Error extracting content from {path}: {e}")
        return ""


def extract_plain_text(file_path, max_length=1000):
    """Extract text from plain text files"""
    try:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read(max_length)
        return content
    except Exception as e:
        print(f"Error reading plain text: {e}")
        return ""


def extract_pdf_text(file_path, max_length=1000):
    """Extract text from PDF files"""
    # Placeholder - requires PyPDF2 or pdfplumber
    # TODO: Implement PDF text extraction
    return ""


def extract_doc_text(file_path, max_length=1000):
    """Extract text from Word documents"""
    # Placeholder - requires python-docx
    # TODO: Implement Word document text extraction
    return ""
