# agent/learning_logic.py
"""
Learning logic that applies user feedback to confidence scores

Key Principles:
- Accept (✓ suggestion): +10% confidence boost for this folder
- Choose different (⚠ wrong): -40% confidence decay for suggested folder
- Ignore (⊘ throwaway): No learning effect (neutral)

This module reads from the learning table and adjusts base confidence
scores based on historical user feedback.
"""
import sqlite3
from collections import defaultdict


def get_learning_effect(action):
    """
    Map user action to learning effect

    Args:
        action: 'accept', 'choose', 'ignore'

    Returns:
        dict: {learning: True/False, strength: 'positive'/'negative'/'none'}
    """
    effects = {
        "accept": {
            "learning": True,
            "strength": "positive",
            "meaning": "Model was correct"
        },
        "choose": {
            "learning": True,
            "strength": "negative",
            "meaning": "Model was wrong"
        },
        "ignore": {
            "learning": False,
            "strength": "none",
            "meaning": "File is not relevant"
        }
    }
    return effects.get(action, {})


def apply_learning(filename, suggested_folder, action):
    """
    Apply learning based on user intent

    Not ML — just evidence aggregation.
    """
    effect = get_learning_effect(action)

    if not effect.get("learning"):
        # Ignore = no learning, no penalty
        return None

    if effect["strength"] == "positive":
        # User accepted suggestion
        # Increase confidence in: filename→folder pattern
        return {
            "pattern": (filename, suggested_folder),
            "boost": True,
            "factor": 0.1  # 10% boost
        }
    elif effect["strength"] == "negative":
        # User rejected suggestion
        # Decrease confidence significantly
        return {
            "pattern": (filename, suggested_folder),
            "boost": False,
            "factor": 0.4  # 40% reduction
        }

    return None


def get_learning_stats(filename, folder):
    """
    Get learning statistics for a specific filename-folder pair

    Args:
        filename: The file being matched
        folder: The folder being suggested

    Returns:
        dict: {
            'accepts': int,      # Times user accepted this folder for this filename
            'rejects': int,      # Times user chose different folder
            'ignores': int,      # Times user ignored (neutral)
            'total': int         # Total interactions
        }
    """
    conn = sqlite3.connect("storage/state.db")
    c = conn.cursor()

    # Get all actions for this filename-folder pair
    c.execute("""
        SELECT action, COUNT(*)
        FROM learning
        WHERE filename = ? AND suggested_folder = ?
        GROUP BY action
    """, (filename, folder))

    results = c.fetchall()
    conn.close()

    stats = {
        'accepts': 0,
        'rejects': 0,
        'ignores': 0,
        'total': 0
    }

    for action, count in results:
        stats['total'] += count
        if action == 'accept':
            stats['accepts'] = count
        elif action == 'choose':
            stats['rejects'] = count
        elif action == 'ignore':
            stats['ignores'] = count

    return stats


def get_folder_learning_pattern(folder):
    """
    Get overall learning pattern for a folder (across all files)

    This helps identify if a folder is generally good or bad at predictions

    Args:
        folder: The folder path

    Returns:
        dict: {
            'total_suggestions': int,
            'accept_rate': float,     # % of times accepted
            'reject_rate': float,     # % of times rejected
            'ignore_rate': float      # % of times ignored
        }
    """
    conn = sqlite3.connect("storage/state.db")
    c = conn.cursor()

    c.execute("""
        SELECT action, COUNT(*)
        FROM learning
        WHERE suggested_folder = ?
        GROUP BY action
    """, (folder,))

    results = c.fetchall()
    conn.close()

    counts = defaultdict(int)
    for action, count in results:
        counts[action] = count

    total = sum(counts.values())

    if total == 0:
        return {
            'total_suggestions': 0,
            'accept_rate': 0.0,
            'reject_rate': 0.0,
            'ignore_rate': 0.0
        }

    return {
        'total_suggestions': total,
        'accept_rate': counts['accept'] / total,
        'reject_rate': counts['choose'] / total,
        'ignore_rate': counts['ignore'] / total
    }


def apply_learning_adjustment(base_confidence, filename, folder):
    """
    Apply learning-based adjustment to base confidence score

    Rules:
    1. If user has ACCEPTED this filename-folder pair before: +10% boost
    2. If user has REJECTED (chose different) before: -40% decay
    3. If user only IGNORED: no change (neutral)
    4. Multiple accepts/rejects compound the effect (capped at ±50%)

    Args:
        base_confidence: Base confidence from matcher (0-1)
        filename: The file being matched
        folder: The folder being suggested

    Returns:
        float: Adjusted confidence (0-1)
    """
    stats = get_learning_stats(filename, folder)

    # No learning history - return base confidence
    if stats['total'] == 0:
        return base_confidence

    # Calculate learning adjustment
    adjustment = 0.0

    # Positive feedback: each accept adds +10% (max +50%)
    if stats['accepts'] > 0:
        adjustment += min(stats['accepts'] * 0.10, 0.50)

    # Negative feedback: each reject subtracts -40% (max -50%)
    if stats['rejects'] > 0:
        adjustment -= min(stats['rejects'] * 0.40, 0.50)

    # Ignores don't affect adjustment (neutral)

    # Apply adjustment and clamp to [0, 1]
    adjusted = base_confidence + adjustment
    return max(0.0, min(1.0, adjusted))


def apply_folder_reputation_boost(confidence, folder):
    """
    Apply small boost/penalty based on folder's overall reputation

    If a folder has historically high acceptance rate, give it a small boost.
    If it has high rejection rate, apply a small penalty.

    This is a GENTLE effect (±5% max) to avoid overfitting.

    Args:
        confidence: Current confidence score
        folder: The folder being suggested

    Returns:
        float: Adjusted confidence with reputation factor
    """
    pattern = get_folder_learning_pattern(folder)

    # Need at least 5 samples for reputation to matter
    if pattern['total_suggestions'] < 5:
        return confidence

    # Calculate reputation score (-1 to +1)
    # High accept rate = positive reputation
    # High reject rate = negative reputation
    reputation = pattern['accept_rate'] - pattern['reject_rate']

    # Apply gentle adjustment (max ±5%)
    adjustment = reputation * 0.05

    adjusted = confidence + adjustment
    return max(0.0, min(1.0, adjusted))


def get_confidence_with_learning(base_confidence, filename, folder):
    """
    Main function: Get final confidence score with learning applied

    This combines:
    1. Base confidence (from matcher)
    2. File-folder specific learning (accept/reject history)
    3. Folder reputation (overall pattern)

    Args:
        base_confidence: Base confidence from matcher (0-1)
        filename: The file being matched
        folder: The folder being suggested

    Returns:
        float: Final confidence with learning (0-1)
    """
    # Step 1: Apply specific learning (strong effect)
    confidence = apply_learning_adjustment(base_confidence, filename, folder)

    # Step 2: Apply folder reputation (gentle effect)
    confidence = apply_folder_reputation_boost(confidence, folder)

    return confidence


def get_learning_insights(limit=10):
    """
    Get insights from learning data for analytics

    Returns:
        dict: {
            'top_folders': [(folder, accept_rate, total_suggestions)],
            'problem_folders': [(folder, reject_rate, total_suggestions)],
            'recent_feedback': [(filename, folder, action, timestamp)]
        }
    """
    conn = sqlite3.connect("storage/state.db")
    c = conn.cursor()

    # Get all folders with learning data
    c.execute("""
        SELECT suggested_folder, action, COUNT(*) as cnt
        FROM learning
        GROUP BY suggested_folder, action
    """)

    folder_stats = defaultdict(lambda: {'accept': 0, 'choose': 0, 'ignore': 0})
    for folder, action, count in c.fetchall():
        folder_stats[folder][action] = count

    # Calculate rates
    folder_rates = []
    for folder, stats in folder_stats.items():
        total = sum(stats.values())
        accept_rate = stats['accept'] / total if total > 0 else 0
        reject_rate = stats['choose'] / total if total > 0 else 0
        folder_rates.append((folder, accept_rate, reject_rate, total))

    # Top folders (high accept rate, min 3 samples)
    top_folders = sorted(
        [(f, ar, t) for f, ar, rr, t in folder_rates if t >= 3],
        key=lambda x: x[1],
        reverse=True
    )[:limit]

    # Problem folders (high reject rate, min 3 samples)
    problem_folders = sorted(
        [(f, rr, t) for f, ar, rr, t in folder_rates if t >= 3],
        key=lambda x: x[1],
        reverse=True
    )[:limit]

    # Recent feedback
    c.execute("""
        SELECT filename, suggested_folder, action, timestamp
        FROM learning
        ORDER BY timestamp DESC
        LIMIT ?
    """, (limit,))

    recent_feedback = c.fetchall()
    conn.close()

    return {
        'top_folders': top_folders,
        'problem_folders': problem_folders,
        'recent_feedback': recent_feedback
    }
