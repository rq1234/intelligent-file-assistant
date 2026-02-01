# ui/batch_prompt.py
"""
Interactive batch processing UI with per-file controls
Encodes user intent explicitly: accept (positive), choose (negative), ignore (no learning)

IMPORTANT: Ignore is a valid outcome
- Ignore means: Don't move, don't prompt again, don't penalize confidence
- Ignore is NOT feedback - it's a preference (throwaway/temporary/irrelevant files)
- Ignore does NOT reduce confidence in the model
- Ignore does NOT force user to choose a folder
"""
import os
from utils.user_input import get_user_input


def display_batch_summary(auto_moved, suggestions):
    """
    Display summary of batch with interactive file-level controls
    
    Implements intent differentiation:
    - accept: User approves suggestion → positive learning
    - choose: User selects different folder → strong negative learning (model was wrong)
    - ignore: User marks as throwaway → no learning (doesn't penalize confidence)
    
    Args:
        auto_moved: List of (filename, folder) already moved
        suggestions: List of (filename, folder, confidence)
        
    Returns:
        dict: User selections {filename: (action_type, chosen_folder)}
        - action_type: 'accept', 'choose', 'ignore'
        - chosen_folder: target folder path (None for ignore)
    """
    
    total_files = len(auto_moved) + len(suggestions)
    print(f"\n{'='*60}")
    print(f"📁 Batch Summary: {total_files} files found")
    print(f"{'='*60}")
    
    # Show auto-moved files (high confidence)
    if auto_moved:
        print(f"\n✅ Auto-moved ({len(auto_moved)}):")
        for filename, folder in auto_moved:
            print(f"   • {filename}")
            print(f"     → {os.path.basename(folder)}")
    
    # Show suggestions requiring user decision
    if suggestions:
        print(f"\n⚠️  Suggestions ({len(suggestions)}):")
        for i, (filename, folder, confidence) in enumerate(suggestions, 1):
            folder_name = os.path.basename(folder)
            conf_pct = int(confidence * 100)
            print(f"   [{i}] {filename}")
            print(f"       Suggested: {folder_name} ({conf_pct}% confidence)")
    
    # Collect per-file decisions
    user_decisions = {}
    
    if suggestions:
        print(f"\n{'='*60}")
        print("Quick options:")
        print(f"  [a]ll approve  [i]ll ignore  [c]hoose per file")
        print(f"{'='*60}")
        
        quick_choice = get_user_input("Quick choice [a/i/c] (default: choose per file): ").strip().lower()

        if quick_choice == "a":
            # Approve all suggestions - NO CONFIRMATION NEEDED
            for filename, folder, confidence in suggestions:
                user_decisions[filename] = ("accept", folder)
            print("✓ All files will be moved to suggested folders")
            print(f"{'='*60}\n")
            return user_decisions  # Skip confirmation, proceed immediately

        elif quick_choice == "i":
            # Ignore all suggestions - NO CONFIRMATION NEEDED
            for filename, folder, confidence in suggestions:
                user_decisions[filename] = ("ignore", None)
            print("✓ All files will be ignored")
            print(f"{'='*60}\n")
            return user_decisions  # Skip confirmation, proceed immediately

        else:
            # Default: choose per file
            print(f"\n{'='*60}")
            print("Choose action for each file:")
            print(f"{'='*60}")
            
            for filename, folder, confidence in suggestions:
                folder_name = os.path.basename(folder)
                conf_pct = int(confidence * 100)
                
                print(f"\n📄 {filename}")
                print(f"   Suggested: {folder_name} ({conf_pct}%)")
                print(f"   Options: [s]uggested  [o]ther folder  [i]gnore")
                
                while True:
                    choice = get_user_input(f"   Your choice [s/o/i]: ").strip().lower()
                    
                    if choice in ["s", ""]:
                        # Accept suggested folder
                        user_decisions[filename] = ("accept", folder)
                        print(f"   ✓ Will move to {folder_name}")
                        break
                        
                    elif choice == "o":
                        # Choose different folder
                        custom = get_user_input(f"   Enter folder path (or press Enter to skip): ").strip()
                        if custom:
                            user_decisions[filename] = ("choose", custom)
                            print(f"   ✓ Will move to {custom}")
                            break
                        else:
                            print(f"   Skipped - will treat as ignore")
                            user_decisions[filename] = ("ignore", None)
                            break
                            
                    elif choice == "i":
                        # Ignore file (don't move, don't learn)
                        user_decisions[filename] = ("ignore", None)
                        print(f"   ✓ Ignored (won't affect learning)")
                        break
                    else:
                        print(f"   Invalid choice. Use [s/o/i]")
    
    # Final confirmation
    if suggestions:
        print(f"\n{'='*60}")
        accepted = sum(1 for _, (a, _) in user_decisions.items() if a == "accept")
        changed = sum(1 for _, (a, _) in user_decisions.items() if a == "choose")
        ignored = sum(1 for _, (a, _) in user_decisions.items() if a == "ignore")
        
        summary = []
        if accepted:
            summary.append(f"{accepted} ✓ accept")
        if changed:
            summary.append(f"{changed} ⚠️ change")
        if ignored:
            summary.append(f"{ignored} ⊘ ignore")
        
        print(f"Summary: {' | '.join(summary)}")
        
        final = get_user_input(f"Proceed with these decisions? [y/n]: ").strip().lower()
        
        if final != "y":
            print("Cancelled - no files were moved")
            return {}
    
    print(f"{'='*60}\n")
    return user_decisions
