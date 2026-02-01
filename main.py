# main.py

import os
from watcher.download_watcher import start_downloads_watcher
from agent.matcher import match
from agent.decision import decide_action
from telemetry.events import log_event
from actions.mover import move_file
from storage.local_store import (
    init_db, load_scopes, save_decision, save_ignore, save_learning,
    is_file_ignored, matches_ignore_pattern, save_ignore_pattern
)
from config.settings import AUTO_MOVE_TH, SUGGEST_TH, BATCH_WINDOW_SECONDS
from agent.batch import BatchManager
from agent.retry_queue import LockedFileQueue
from ui.batch_prompt import display_batch_summary
from utils.user_input import get_user_input, get_processing_state


init_db()
scopes = load_scopes()
processing_state = get_processing_state()  # Global state for coordinating processing


batch_manager = BatchManager(window_seconds=BATCH_WINDOW_SECONDS)
locked_files = LockedFileQueue(max_retries=5)


def handle_new_file(file_path):
    """Queue files for batch processing"""
    batch_manager.add_file(file_path)


def handle_single_file(file_path):
    """
    Process single file immediately (Case A: single file after 10 seconds)
    No batching, no UI prompt - just auto-move if confident or ask if borderline
    """
    filename = os.path.basename(file_path)
    
    # Skip ignored files
    if is_file_ignored(filename):
        log_event("file_skipped", {"reason": "already_ignored"})
        return
    
    if matches_ignore_pattern(filename):
        log_event("file_skipped", {"reason": "matches_ignore_pattern"})
        save_ignore(filename, "matches_ignore_pattern")
        return
    
    result = match(file_path, scopes)
    if not result["folder"]:
        return

    confidence = result["confidence"]
    folder = result["folder"]
    action = decide_action(confidence, AUTO_MOVE_TH, SUGGEST_TH)

    if action == "auto_move":
        log_event("auto_move", {"confidence_bucket": "high"})
        success, error = move_file(file_path, folder)
        if success:
            save_decision(filename, folder)
            save_learning(filename, folder, "accept")
            print(f"\n[auto] {filename} → {os.path.basename(folder)}")
        elif error == 'locked':
            print(f"   → Will retry automatically...")
            locked_files.add(file_path, folder, {'action': 'accept', 'folder': folder})
    elif action == "ask":
        # Single file with borderline confidence - ask user
        log_event("suggestion_shown", {"confidence_bucket": "medium"})
        print(f"\n[ask] {filename}")
        print(f"      Suggested: {os.path.basename(folder)} ({int(confidence*100)}%)")
        choice = get_user_input("      [s]uggested / [o]ther / [i]gnore: ").strip().lower()

        if choice in ["s", ""]:
            success, error = move_file(file_path, folder)
            if success:
                save_decision(filename, folder)
                save_learning(filename, folder, "accept")
            elif error == 'locked':
                print(f"   → Will retry automatically...")
                locked_files.add(file_path, folder, {'action': 'accept', 'folder': folder})
        elif choice == "o":
            custom = get_user_input("      Enter folder path: ").strip()
            if custom:
                success, error = move_file(file_path, custom)
                if success:
                    save_decision(filename, custom)
                    save_learning(filename, folder, "choose")
                elif error == 'locked':
                    print(f"   → Will retry automatically...")
                    locked_files.add(file_path, custom, {'action': 'choose', 'folder': custom})
        elif choice == "i":
            save_ignore(filename, "user_ignored_suggestion")
            ask_ignore_pattern(filename)


def handle_batch(file_paths):
    """
    Process batch in two stages:
    Stage 1: Console notification - ephemeral awareness
    Stage 2: Terminal prompt - actual user interaction
    """
    
    # STAGE 1: Categorize files and show notification
    auto_moved = []
    suggestions = []
    skipped = []

    # First pass: categorize files
    for file_path in file_paths:
        filename = os.path.basename(file_path)
        
        # Skip files that user already ignored
        if is_file_ignored(filename):
            log_event("file_skipped", {"reason": "already_ignored"})
            skipped.append(filename)
            continue
        
        # Skip files matching ignore patterns
        if matches_ignore_pattern(filename):
            log_event("file_skipped", {"reason": "matches_ignore_pattern"})
            save_ignore(filename, "matches_ignore_pattern")
            skipped.append(filename)
            continue
        
        result = match(file_path, scopes)
        if not result["folder"]:
            continue

        confidence = result["confidence"]
        folder = result["folder"]
        action = decide_action(confidence, AUTO_MOVE_TH, SUGGEST_TH)

        if action == "auto_move":
            log_event("auto_move", {"confidence_bucket": "high"})
            success, error = move_file(file_path, folder)
            if success:
                save_decision(filename, folder)
                save_learning(filename, folder, "accept")
                auto_moved.append((filename, folder))
            elif error == 'locked':
                locked_files.add(file_path, folder, {'action': 'accept', 'folder': folder})
        elif action == "ask":
            log_event("suggestion_shown", {"confidence_bucket": "medium"})
            suggestions.append((file_path, folder, confidence))

    # Stage 1 notification: console log showing readiness
    total_files = len(auto_moved) + len(suggestions) + len(skipped)
    if total_files > 0:
        print(f"\n[info] {total_files} files ready to organise")
        if auto_moved:
            print(f"       ✓ {len(auto_moved)} auto-moved")
        if suggestions:
            print(f"       ? {len(suggestions)} need your decision")
        if skipped:
            print(f"       ⊘ {len(skipped)} skipped (ignored patterns)")
        if locked_files.size() > 0:
            print(f"       🔒 {locked_files.size()} locked (will retry)")

    # STAGE 2: Interactive prompt for user decisions
    if suggestions:
        user_decisions = display_batch_summary(auto_moved, suggestions)

        # Check if user cancelled (empty decisions)
        if not user_decisions:
            print("\n[INFO] No decisions made - operation cancelled\n")
            return

        print(f"\n[INFO] Processing {len(user_decisions)} user decisions...")

        for file_path, suggested_folder, confidence in suggestions:
            filename = os.path.basename(file_path)

            if filename not in user_decisions:
                print(f"[SKIP] {filename} - no decision found")
                continue

            action_type, chosen_folder = user_decisions[filename]
            print(f"\n[PROCESS] {filename}")
            print(f"          Action: {action_type}")

            if action_type == "accept":
                # User accepted the suggestion
                log_event("suggestion_accepted", {"confidence": confidence})
                print(f"          Moving to: {os.path.basename(suggested_folder)}")
                success, error = move_file(file_path, suggested_folder)
                if success:
                    save_decision(filename, suggested_folder)
                    save_learning(filename, suggested_folder, "accept")
                elif error == 'locked':
                    print(f"          File locked - will retry later")
                    locked_files.add(file_path, suggested_folder, {'action': 'accept', 'folder': suggested_folder})
                elif error == 'duplicate':
                    print(f"          Duplicate detected - skipped")
                else:
                    print(f"          Error: {error}")

            elif action_type == "choose":
                # User chose a different folder (strong negative feedback)
                log_event("suggestion_rejected_with_alternative", {"confidence": confidence})
                if chosen_folder:
                    print(f"          Moving to: {os.path.basename(chosen_folder)}")
                    success, error = move_file(file_path, chosen_folder)
                    if success:
                        save_decision(filename, chosen_folder)
                        save_learning(filename, suggested_folder, "choose")  # Learn that suggestion was wrong
                    elif error == 'locked':
                        print(f"          File locked - will retry later")
                        locked_files.add(file_path, chosen_folder, {'action': 'choose', 'folder': chosen_folder, 'suggested': suggested_folder})
                    elif error == 'duplicate':
                        print(f"          Duplicate detected - skipped")
                    else:
                        print(f"          Error: {error}")

            elif action_type == "ignore":
                # User ignored the file (no learning, no move)
                log_event("file_ignored", {"confidence": confidence})
                save_ignore(filename, "user_ignored_suggestion")
                print(f"          Ignored - no move")

                # Ask if user wants to ignore similar files in the future
                ask_ignore_pattern(filename)

        print(f"\n[DONE] Batch processing complete\n")


def ask_ignore_pattern(filename):
    """
    Ask user if they want to ignore files matching this pattern in the future
    
    This is a PREFERENCE, not feedback - doesn't affect confidence learning
    
    Args:
        filename: File that was ignored
    """
    # Suggest common patterns based on file characteristics
    ext = os.path.splitext(filename)[1].lower()
    name_prefix = os.path.splitext(filename)[0]
    
    suggestions = []
    
    # Extension-based pattern
    if ext:
        suggestions.append(f"*{ext}")
    
    # Common temporary file patterns
    if filename.startswith("~"):
        suggestions.append("~*")
    if filename.startswith("."):
        suggestions.append(".*")
    if "tmp" in filename.lower() or "temp" in filename.lower():
        suggestions.append("*tmp*")
        suggestions.append("*temp*")
    
    if not suggestions:
        return
    
    # Deduplicate
    suggestions = list(set(suggestions))
    
    print(f"\n❓ Should we ignore files like '{filename}' in the future?")
    for i, pattern in enumerate(suggestions, 1):
        print(f"  [{i}] {pattern}")
    print(f"  [0] No thanks")

    try:
        choice = get_user_input("  Choose: ").strip()
        if choice.isdigit() and 0 < int(choice) <= len(suggestions):
            pattern = suggestions[int(choice) - 1]
            save_ignore_pattern(pattern, f"inferred_from_{filename}")
            log_event("ignore_pattern_created", {"pattern": pattern, "source": filename})
            print(f"  ✓ Will ignore {pattern} in the future")
    except (ValueError, IndexError):
        pass


def process_locked_retries():
    """
    Process files ready for retry from locked queue
    Returns number of files successfully moved
    """
    ready_files = locked_files.get_ready_files()
    if not ready_files:
        return 0
    
    moved_count = 0
    for file_path, folder, user_choice in ready_files:
        if not os.path.exists(file_path):
            # File was moved/deleted externally
            locked_files.remove(file_path)
            continue
        
        filename = os.path.basename(file_path)
        success, error = move_file(file_path, folder)
        
        if success:
            # Successfully moved!
            moved_count += 1
            locked_files.remove(file_path)
            
            # Apply user's original decision
            if user_choice:
                action = user_choice.get('action')
                if action == 'accept':
                    save_decision(filename, folder)
                    save_learning(filename, folder, "accept")
                elif action == 'choose':
                    save_decision(filename, folder)
                    suggested = user_choice.get('suggested', folder)
                    save_learning(filename, suggested, "choose")
            
            print(f"🔓 Retry success: {filename} → {os.path.basename(folder)}")
            
        elif error == 'locked':
            # Still locked - increment retry counter
            locked_files.mark_retry(file_path)
            
            if locked_files.should_give_up(file_path):
                print(f"❌ Giving up on {filename} after 5 retries - file still locked")
                locked_files.remove(file_path)
        else:
            # Other error - remove from queue
            locked_files.remove(file_path)
    
    return moved_count


def resolve_downloads_path():
    """Resolve the most likely Downloads folder on Windows/OneDrive setups."""
    candidates = []

    user_profile = os.environ.get("USERPROFILE")
    if user_profile:
        candidates.append(os.path.join(user_profile, "Downloads"))

    one_drive = os.environ.get("OneDrive")
    if one_drive:
        candidates.append(os.path.join(one_drive, "Downloads"))

    one_drive_consumer = os.environ.get("OneDriveConsumer")
    if one_drive_consumer:
        candidates.append(os.path.join(one_drive_consumer, "Downloads"))

    one_drive_commercial = os.environ.get("OneDriveCommercial")
    if one_drive_commercial:
        candidates.append(os.path.join(one_drive_commercial, "Downloads"))

    candidates.append(os.path.expanduser("~/Downloads"))

    for path in candidates:
        if path and os.path.exists(path):
            return path

    return os.path.expanduser("~/Downloads")


if __name__ == "__main__":
    downloads_path = resolve_downloads_path()
    print(f"Watching {downloads_path} for new files...")
    print("Press Ctrl+C to stop\n")
    
    def on_batch_ready(batch):
        """Route batch to single or multi-file handler"""
        if len(batch) == 1:
            handle_single_file(batch[0])
        else:
            handle_batch(batch)
    
    try:
        start_downloads_watcher(
            downloads_path,
            handle_new_file,
            on_batch_callback=on_batch_ready,
            batch_manager=batch_manager,
            retry_callback=process_locked_retries,
            processing_state=processing_state
        )
    except Exception as e:
        import traceback
        print(f"\n[ERROR] Fatal error: {e}")
        traceback.print_exc()
        exit(1)
