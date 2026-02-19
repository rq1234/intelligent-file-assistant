# agent/confidence.py

def compute_confidence(
    memory_score: float,
    token_score: float,
    fuzzy_score: float,
    content_score: float,
    file_type_weight: float
) -> float:
    """
    Compute overall confidence score for folder suggestion
    
    Returns confidence in [0, 1]
    
    Key intuition:
    - Memory wins immediately (past decisions trusted)
    - Filename structure matters most
    - Content helps when filenames are bad
    - File type scales trust
    
    This is not ML — it's evidence aggregation.
    """
    
    # If we have memory (past decision), trust it completely
    if memory_score > 0:
        return memory_score
    
    # Combine scores with weights
    combined = (
        0.4 * token_score +
        0.3 * fuzzy_score +
        0.3 * content_score
    )
    
    # Obvious-match boost: very high fuzzy + good token overlap
    if fuzzy_score >= 0.9 and token_score >= 0.5:
        combined = max(combined, 0.75)
    
    # Soften file-type penalty so good matches don't get crushed
    type_factor = 0.7 + 0.3 * file_type_weight
    return min(combined * type_factor, 1.0)
