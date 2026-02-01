#!/usr/bin/env python3
# undo_cli.py
"""
Undo CLI - Revert recent file moves

Usage:
    python undo_cli.py              # Interactive mode (shows history)
    python undo_cli.py --last       # Undo last move immediately
    python undo_cli.py --history    # Show history only (no undo)
"""
import sys
from actions.undo import undo_interactive, undo_last_move, show_undo_history


def main():
    if len(sys.argv) > 1:
        arg = sys.argv[1].lower()

        if arg in ['--last', '-l']:
            # Undo last move immediately
            print("\nUndoing last move...")
            undo_last_move()

        elif arg in ['--history', '-h']:
            # Show history only
            show_undo_history(10)

        elif arg in ['--help']:
            print(__doc__)

        else:
            print(f"Unknown argument: {arg}")
            print(__doc__)
    else:
        # Interactive mode
        undo_interactive()


if __name__ == "__main__":
    main()
