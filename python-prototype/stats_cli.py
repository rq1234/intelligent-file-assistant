#!/usr/bin/env python3
# stats_cli.py
"""
Analytics Dashboard - View learning statistics and insights

Shows:
- Top performing folders (high acceptance rate)
- Problem folders (high rejection rate)
- Recent user feedback
- Overall system performance

Usage:
    python stats_cli.py              # Show full dashboard
    python stats_cli.py --summary    # Brief summary only
"""
import sys
import os
from agent.learning_logic import get_learning_insights
from storage.local_store import get_undo_history
import sqlite3


def show_dashboard():
    """Display full analytics dashboard"""

    print("\n" + "="*70)
    print(" 📊 File Organizer - Learning Analytics Dashboard")
    print("="*70)

    # Get insights
    insights = get_learning_insights(limit=10)

    # Overall stats
    conn = sqlite3.connect("storage/state.db")
    c = conn.cursor()

    # Total suggestions made
    c.execute("SELECT COUNT(*) FROM learning")
    total_suggestions = c.fetchone()[0]

    # Breakdown by action
    c.execute("""
        SELECT action, COUNT(*)
        FROM learning
        GROUP BY action
    """)
    action_counts = dict(c.fetchall())

    # Total moves (from undo history)
    c.execute("SELECT COUNT(*) FROM undo_history")
    total_moves = c.fetchone()[0]

    # Total decisions
    c.execute("SELECT COUNT(*) FROM decisions")
    total_decisions = c.fetchone()[0]

    conn.close()

    # Display overall stats
    print("\n📈 Overall Statistics")
    print("-" * 70)
    print(f"  Total Suggestions Made:     {total_suggestions}")
    print(f"  Total Moves Executed:       {total_moves}")
    print(f"  Total Decisions Stored:     {total_decisions}")

    if total_suggestions > 0:
        accepts = action_counts.get('accept', 0)
        rejects = action_counts.get('choose', 0)
        ignores = action_counts.get('ignore', 0)

        print(f"\n  User Feedback Breakdown:")
        print(f"    ✓ Accepted:    {accepts:3d} ({accepts/total_suggestions*100:5.1f}%)")
        print(f"    ⚠ Rejected:    {rejects:3d} ({rejects/total_suggestions*100:5.1f}%)")
        print(f"    ⊘ Ignored:     {ignores:3d} ({ignores/total_suggestions*100:5.1f}%)")

        if accepts + rejects > 0:
            accuracy = accepts / (accepts + rejects) * 100
            print(f"\n  Model Accuracy: {accuracy:.1f}% (excludes ignores)")

    # Top folders
    if insights['top_folders']:
        print("\n✅ Top Performing Folders (High Acceptance Rate)")
        print("-" * 70)
        for folder, accept_rate, total in insights['top_folders'][:5]:
            folder_name = os.path.basename(folder)
            print(f"  {folder_name:30s}  {accept_rate*100:5.1f}%  ({total} suggestions)")

    # Problem folders
    if insights['problem_folders']:
        print("\n❌ Problem Folders (High Rejection Rate)")
        print("-" * 70)
        for folder, reject_rate, total in insights['problem_folders'][:5]:
            folder_name = os.path.basename(folder)
            print(f"  {folder_name:30s}  {reject_rate*100:5.1f}%  ({total} suggestions)")

    # Recent feedback
    if insights['recent_feedback']:
        print("\n🕐 Recent User Feedback")
        print("-" * 70)
        for filename, folder, action, timestamp in insights['recent_feedback'][:5]:
            folder_name = os.path.basename(folder)
            timestamp_short = timestamp.split('T')[0] if 'T' in timestamp else timestamp

            action_symbol = {
                'accept': '✓',
                'choose': '⚠',
                'ignore': '⊘'
            }.get(action, '?')

            print(f"  {action_symbol} {filename[:30]:30s} → {folder_name:20s}  {timestamp_short}")

    # Undo history
    recent_undos = get_undo_history(3)
    if recent_undos:
        print("\n↩️  Recent Undos (Mistakes Corrected)")
        print("-" * 70)
        for entry in recent_undos:
            filename = entry['file']
            from_folder = os.path.basename(os.path.dirname(entry['from']))
            to_folder = os.path.basename(os.path.dirname(entry['to']))
            timestamp = entry['timestamp'].split('T')[0]
            print(f"  {filename[:30]:30s}  {to_folder} → {from_folder}  {timestamp}")

    print("\n" + "="*70)
    print("\nTip: Use 'python undo_cli.py' to undo incorrect moves")
    print("="*70 + "\n")


def show_summary():
    """Display brief summary"""

    conn = sqlite3.connect("storage/state.db")
    c = conn.cursor()

    # Get action breakdown
    c.execute("""
        SELECT action, COUNT(*)
        FROM learning
        GROUP BY action
    """)
    action_counts = dict(c.fetchall())
    conn.close()

    total = sum(action_counts.values())

    if total == 0:
        print("\nNo learning data yet. Start using the file organizer to see stats!")
        return

    accepts = action_counts.get('accept', 0)
    rejects = action_counts.get('choose', 0)
    ignores = action_counts.get('ignore', 0)

    print(f"\n📊 Quick Stats: {total} total suggestions")
    print(f"   ✓ {accepts} accepted  ⚠ {rejects} rejected  ⊘ {ignores} ignored")

    if accepts + rejects > 0:
        accuracy = accepts / (accepts + rejects) * 100
        print(f"   Accuracy: {accuracy:.1f}%")

    print()


def main():
    if len(sys.argv) > 1:
        arg = sys.argv[1].lower()

        if arg in ['--summary', '-s']:
            show_summary()
        elif arg in ['--help', '-h']:
            print(__doc__)
        else:
            print(f"Unknown argument: {arg}")
            print(__doc__)
    else:
        show_dashboard()


if __name__ == "__main__":
    main()
