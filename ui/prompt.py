"""
User interface prompts and interactions
"""


def get_user_confirmation(message, default=True):
    """
    Get user confirmation for an action
    
    Args:
        message: The message to display
        default: Default response if user just presses Enter
        
    Returns:
        bool: True if user confirms, False otherwise
    """
    default_str = "Y/n" if default else "y/N"
    response = input(f"{message} [{default_str}]: ").strip().lower()
    
    if not response:
        return default
    
    return response in ['y', 'yes']


def display_menu(options):
    """
    Display a menu and get user choice
    
    Args:
        options: List of menu options
        
    Returns:
        int: Selected option index (0-based)
    """
    print("\nPlease select an option:")
    for i, option in enumerate(options, 1):
        print(f"{i}. {option}")
    
    while True:
        try:
            choice = input("\nEnter your choice: ").strip()
            choice_num = int(choice)
            
            if 1 <= choice_num <= len(options):
                return choice_num - 1
            else:
                print(f"Please enter a number between 1 and {len(options)}")
        except ValueError:
            print("Please enter a valid number")


def display_action_summary(action):
    """
    Display a summary of an action
    
    Args:
        action: Action dictionary
    """
    print("\n" + "="*50)
    print(f"Action: {action['type'].upper()}")
    print(f"Source: {action['source']}")
    print(f"Target: {action['target']}")
    print(f"Time: {action['timestamp']}")
    print("="*50 + "\n")


def display_file_info(features, decision=None):
    """
    Display information about a file and its decision
    
    Args:
        features: File features dictionary
        decision: Decision dictionary (optional)
    """
    print("\n" + "-"*50)
    print(f"File: {features['name']}")
    print(f"Type: {features['extension']}")
    print(f"Size: {features['size']} bytes")
    print(f"Modified: {features['modified']}")
    
    if decision:
        print(f"\nRecommended action:")
        print(f"  Destination: {decision.get('target_path')}")
        print(f"  Confidence: {decision.get('confidence', 0):.2%}")
        print(f"  Reason: {decision.get('reason', 'N/A')}")
    
    print("-"*50 + "\n")
