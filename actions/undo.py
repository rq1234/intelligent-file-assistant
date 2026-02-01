# actions/undo.py
"""
Undo functionality for file moves

Allows users to revert recent file moves and provides feedback
to the learning system that the suggestion was wrong.
"""
import os
import shutil
from storage.local_store import get_undo_history
import sqlite3


def show_undo_history(limit=10):
    """
    Display recent file moves that can be undone

    Args:
        limit: Number of recent moves to show

    Returns:
        list: Undo history entries
    """
    history = get_undo_history(limit)

    if not history:
        print("\nNo recent moves to undo.\n")
        return []

    print(f"\n{'='*60}")
    print("Recent Moves (Undo History)")
    print(f"{'='*60}")

    for i, entry in enumerate(history, 1):
        filename = entry['file']
        from_folder = os.path.basename(os.path.dirname(entry['from']))
        to_folder = os.path.basename(os.path.dirname(entry['to']))
        timestamp = entry['timestamp'].split('T')[0]  # Just date

        print(f"{i}. {filename}")
        print(f"   {from_folder} → {to_folder}")
        print(f"   Date: {timestamp}")
        print()

    return history


def undo_move(move_id=None):
    """
    Undo a specific move or the last move

    Args:
        move_id: ID from undo_history table (None = last move)

    Returns:
        bool: Success status
    """
    conn = sqlite3.connect("storage/state.db")
    c = conn.cursor()

    if move_id is None:
        # Get the most recent move
        c.execute("""
            SELECT id, filename, src, dst
            FROM undo_history
            ORDER BY id DESC
            LIMIT 1
        """)
    else:
        # Get specific move by ID
        c.execute("""
            SELECT id, filename, src, dst
            FROM undo_history
            WHERE id = ?
        """, (move_id,))

    row = c.fetchone()

    if not row:
        conn.close()
        print("❌ No move found to undo")
        return False

    move_id, filename, src, dst = row

    # Check if destination file still exists
    if not os.path.exists(dst):
        print(f"❌ Cannot undo: File no longer at {dst}")
        conn.close()
        return False

    # Check if source location is available
    if os.path.exists(src):
        print(f"❌ Cannot undo: A file already exists at {src}")
        conn.close()
        return False

    try:
        # Move file back to original location
        shutil.move(dst, src)

        # Remove from undo history
        c.execute("DELETE FROM undo_history WHERE id = ?", (move_id,))

        # Remove from decisions (so it doesn't get auto-moved again)
        c.execute("DELETE FROM decisions WHERE filename = ?", (filename,))

        # Add negative learning signal (this move was wrong)
        # Get the folder that was suggested
        suggested_folder = os.path.dirname(dst)
        c.execute("""
            INSERT INTO learning (filename, suggested_folder, action, timestamp)
            VALUES (?, ?, 'choose', datetime('now'))
        """, (filename, suggested_folder))

        conn.commit()
        conn.close()

        print(f"✓ Undone: {filename}")
        print(f"  Moved back from {os.path.basename(os.path.dirname(dst))} → {os.path.basename(os.path.dirname(src))}")
        print(f"  Learning: This folder suggestion will be penalized in future")
        return True

    except Exception as e:
        conn.close()
        print(f"❌ Error undoing move: {e}")
        return False


def undo_interactive():
    """
    Interactive undo interface - shows history and lets user pick which to undo
    """
    history = show_undo_history(10)

    if not history:
        return

    print("Options:")
    print("  [1-10] Undo specific move")
    print("  [0] Cancel")

    try:
        choice = input("\nYour choice: ").strip()

        if choice == "0":
            print("Cancelled")
            return

        idx = int(choice) - 1
        if 0 <= idx < len(history):
            # Get the move ID from history
            # We need to query the DB to get the actual ID
            entry = history[idx]
            filename = entry['file']
            dst = entry['to']

            conn = sqlite3.connect("storage/state.db")
            c = conn.cursor()
            c.execute("""
                SELECT id FROM undo_history
                WHERE filename = ? AND dst = ?
                ORDER BY id DESC
                LIMIT 1
            """, (filename, dst))
            row = c.fetchone()
            conn.close()

            if row:
                move_id = row[0]
                undo_move(move_id)
            else:
                print("❌ Move not found in database")
        else:
            print("❌ Invalid choice")

    except (ValueError, IndexError):
        print("❌ Invalid input")


def undo_last_move():
    """Quick function to undo the most recent move"""
    return undo_move(None)

