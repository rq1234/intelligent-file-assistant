"""
AI agent module for intelligent file organization
"""
from .matcher import match, suggest_folder
from .decision import decide_action
from .confidence import compute_confidence
from .learning_logic import (
    get_confidence_with_learning,
    get_learning_insights,
    get_learning_stats,
    apply_learning_adjustment
)

__all__ = [
    'match',
    'suggest_folder',
    'decide_action',
    'compute_confidence',
    'get_confidence_with_learning',
    'get_learning_insights',
    'get_learning_stats',
    'apply_learning_adjustment'
]
