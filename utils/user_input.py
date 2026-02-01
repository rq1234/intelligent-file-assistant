"""
Shared state and utilities for coordinating user input with background processing
"""


class ProcessingState:
    """Shared state to coordinate processing and user input"""
    def __init__(self):
        self.user_input_in_progress = False

    def pause_for_input(self):
        """Call before requesting user input"""
        self.user_input_in_progress = True

    def resume_processing(self):
        """Call after user input is complete"""
        self.user_input_in_progress = False

    def is_paused(self):
        """Check if processing should be paused"""
        return self.user_input_in_progress


# Global singleton instance
_processing_state = ProcessingState()


def get_user_input(prompt):
    """
    Get user input while pausing all background processing

    This ensures a clean, synchronous UX where nothing happens
    while the user is typing (standard CLI behavior like git, npm, etc.)

    Args:
        prompt: The prompt to display to the user

    Returns:
        str: The user's input
    """
    _processing_state.pause_for_input()
    try:
        result = input(prompt)
        return result
    finally:
        _processing_state.resume_processing()


def get_processing_state():
    """Get the global processing state instance"""
    return _processing_state
