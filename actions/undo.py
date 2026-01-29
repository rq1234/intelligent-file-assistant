"""
Undo functionality for reversing file operations
"""
import shutil
from pathlib import Path


def undo_last_action(store):
    """
    Undo the last file operation
    
    Args:
        store: LocalStore instance containing action history
        
    Returns:
        bool: True if successful, False otherwise
    """
    try:
        last_action = store.get_last_action()
        
        if not last_action:
            print("No actions to undo")
            return False
        
        action_type = last_action.get('type')
        
        if action_type == 'move':
            return undo_move(last_action, store)
        elif action_type == 'copy':
            return undo_copy(last_action, store)
        else:
            print(f"Unknown action type: {action_type}")
            return False
            
    except Exception as e:
        print(f"Error undoing action: {e}")
        return False


def undo_move(action, store):
    """
    Undo a move operation
    
    Args:
        action: Action dictionary with source and target
        store: LocalStore instance
        
    Returns:
        bool: True if successful, False otherwise
    """
    try:
        source = Path(action['source'])
        target = Path(action['target'])
        
        if not target.exists():
            print(f"Target file no longer exists: {target}")
            return False
        
        # Move the file back to its original location
        shutil.move(str(target), str(source))
        
        # Mark the action as undone
        store.mark_action_undone(action)
        
        print(f"Undone: Moved {target} back to {source}")
        return True
        
    except Exception as e:
        print(f"Error undoing move: {e}")
        return False


def undo_copy(action, store):
    """
    Undo a copy operation (delete the copied file)
    
    Args:
        action: Action dictionary with source and target
        store: LocalStore instance
        
    Returns:
        bool: True if successful, False otherwise
    """
    try:
        target = Path(action['target'])
        
        if not target.exists():
            print(f"Copied file no longer exists: {target}")
            return False
        
        # Delete the copied file
        target.unlink()
        
        # Mark the action as undone
        store.mark_action_undone(action)
        
        print(f"Undone: Deleted copied file {target}")
        return True
        
    except Exception as e:
        print(f"Error undoing copy: {e}")
        return False


def get_undo_history(store, limit=10):
    """
    Get the history of actions that can be undone
    
    Args:
        store: LocalStore instance
        limit: Maximum number of actions to return
        
    Returns:
        list: List of action dictionaries
    """
    return store.get_action_history(limit)
