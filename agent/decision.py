# agent/decision.py

def decide_action(confidence, auto_th=0.85, suggest_th=0.4):
    """
    Decide whether to auto-move, ask user, or ignore
    
    This is product logic, not ML logic.
    
    Args:
        confidence: Confidence score [0, 1]
        auto_th: Auto-move threshold
        suggest_th: Suggestion threshold
        
    Returns:
        str: "auto_move", "ask", or "ignore"
    """
    if confidence >= auto_th:
        return "auto_move"
    elif confidence >= suggest_th:
        return "ask"
    else:
        return "ignore"

