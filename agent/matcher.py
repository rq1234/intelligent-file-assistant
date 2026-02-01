import os
import re
import sqlite3
from rapidfuzz import fuzz
from features.content_extractors import extract_title, extract_image_text, is_image

# File-type priority weights
FILE_TYPE_PRIORS = {
    ".pdf": 1.0,
    ".docx": 0.9,
    ".pptx": 0.9,
    ".ipynb": 0.9,
    ".png": 0.2,
    ".jpg": 0.2,
    ".zip": 0.4
}


def tokenize(text):
    """Extract alphanumeric tokens from text"""
    return set(re.findall(r"[a-zA-Z0-9]+", text.lower()))


def token_overlap_score(filename, folder_name):
    """Calculate token overlap between filename and folder name"""
    file_tokens = tokenize(filename)
    folder_tokens = tokenize(folder_name)
    
    if not folder_tokens or not file_tokens:
        return 0.0
    
    overlap = file_tokens.intersection(folder_tokens)
    union = file_tokens.union(folder_tokens)
    jaccard = len(overlap) / len(union)
    
    # Bonus when all folder tokens appear in filename (common exact-match signal)
    coverage = len(overlap) / len(folder_tokens)
    return max(jaccard, coverage)


def fuzzy_score(a, b):
    """Calculate fuzzy similarity score (0-1)"""
    return fuzz.partial_ratio(a.lower(), b.lower()) / 100.0


def combined_score(filename, folder):
    """Combine token overlap and fuzzy matching scores"""
    token_score = token_overlap_score(filename, folder)
    fuzzy = fuzzy_score(filename, folder)
    return max(token_score, fuzzy * 0.7)


def file_type_weight(file_path):
    """Get priority weight based on file extension"""
    ext = os.path.splitext(file_path)[1].lower()
    return FILE_TYPE_PRIORS.get(ext, 0.8)


def match(file_path, scopes):
    """
    Match file to best folder and return result with confidence
    
    Returns:
        dict: {
            "folder": path or None,
            "confidence": float [0, 1],
            "memory_score": float,
            "token_score": float,
            "fuzzy_score": float,
            "content_score": float,
            "file_type_weight": float
        }
    """
    from agent.confidence import compute_confidence
    
    filename = os.path.basename(file_path)

    # 1. Check past decisions (memory)
    conn = sqlite3.connect("storage/state.db")
    c = conn.cursor()
    c.execute("SELECT folder FROM decisions WHERE filename = ?", (filename,))
    row = c.fetchone()
    conn.close()

    if row:
        return {
            "folder": row[0],
            "confidence": 1.0,
            "memory_score": 1.0,
            "token_score": 0,
            "fuzzy_score": 0,
            "content_score": 0,
            "file_type_weight": 1.0,
            "method": "memory"
        }

    # 2. Try LLM classification first
    from agent.llm_classifier import classify_file

    # Collect all available folders
    available_folders = []
    for scope in scopes:
        root = scope["root"]
        root_expanded = os.path.expanduser(root)
        if not os.path.exists(root_expanded):
            continue
        for folder in os.listdir(root_expanded):
            folder_path = os.path.join(root_expanded, folder)
            if os.path.isdir(folder_path):
                available_folders.append(folder_path)

    # Try LLM classification
    llm_result = classify_file(file_path, available_folders)

    if llm_result and llm_result.get("confidence", 0) > 0:
        # LLM succeeded - apply learning adjustments
        llm_confidence = llm_result["confidence"]
        llm_folder = llm_result["folder"]

        from agent.learning_logic import get_confidence_with_learning
        final_confidence = get_confidence_with_learning(
            llm_confidence,
            filename,
            llm_folder
        )

        return {
            "folder": llm_folder,
            "confidence": final_confidence,
            "memory_score": 0,
            "token_score": 0,
            "fuzzy_score": 0,
            "content_score": llm_confidence,  # Store LLM score as content score
            "file_type_weight": 1.0,
            "method": "llm",
            "reasoning": llm_result.get("reasoning", "")
        }

    # 3. Fall back to string-based matching if LLM fails
    best_score = 0
    best_folder = None
    best_token = 0
    best_fuzzy = 0
    best_content = 0

    for scope in scopes:
        root = scope["root"]
        root_expanded = os.path.expanduser(root)
        if not os.path.exists(root_expanded):
            continue

        for folder in os.listdir(root_expanded):
            folder_path = os.path.join(root_expanded, folder)
            if not os.path.isdir(folder_path):
                continue
            
            # Calculate individual scores
            token_sc = token_overlap_score(filename, folder)
            fuzzy_sc = fuzzy_score(filename, folder)
            
            # Extract and score content if available
            content_sc = 0
            
            # Use OCR for images, title extraction for docs
            if is_image(file_path):
                content = extract_image_text(file_path)
            else:
                content = extract_title(file_path)
            
            if content:
                content_sc = max(
                    token_overlap_score(content, folder),
                    fuzzy_score(content, folder)
                )
            
            # Combined score
            score = max(token_sc, fuzzy_sc * 0.7, content_sc)
            
            # Apply file-type weight
            ft_weight = file_type_weight(file_path)
            weighted_score = score * ft_weight
            
            if weighted_score > best_score:
                best_score = weighted_score
                best_folder = folder_path
                best_token = token_sc
                best_fuzzy = fuzzy_sc
                best_content = content_sc

    # Compute base confidence
    ft_weight = file_type_weight(file_path)
    base_confidence = compute_confidence(
        memory_score=0,
        token_score=best_token,
        fuzzy_score=best_fuzzy,
        content_score=best_content,
        file_type_weight=ft_weight
    )

    # Apply learning adjustments if we have a folder match
    final_confidence = base_confidence
    if best_folder:
        from agent.learning_logic import get_confidence_with_learning
        final_confidence = get_confidence_with_learning(
            base_confidence,
            filename,
            best_folder
        )

    return {
        "folder": best_folder if best_score > 0 else None,
        "confidence": final_confidence,
        "memory_score": 0,
        "token_score": best_token,
        "fuzzy_score": best_fuzzy,
        "content_score": best_content,
        "file_type_weight": ft_weight,
        "method": "string"
    }


def suggest_folder(file_path, scopes):
    """Legacy function - returns just the folder"""
    result = match(file_path, scopes)
    if result["confidence"] > 0.3:
        return result["folder"]
    return None

