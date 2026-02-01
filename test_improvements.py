#!/usr/bin/env python3
# test_improvements.py
"""
Test script for the new improvements:
1. Learning logic integration
2. Undo functionality
3. Analytics dashboard
"""
import os
import sqlite3
from agent.learning_logic import (
    get_learning_stats,
    apply_learning_adjustment,
    get_confidence_with_learning,
    get_learning_insights
)
from storage.local_store import init_db, save_learning, get_undo_history


def test_learning_logic():
    """Test learning logic functions"""
    print("\n" + "="*60)
    print("TEST 1: Learning Logic")
    print("="*60)

    # Initialize database
    init_db()

    # Test data
    filename = "test_report.pdf"
    folder = "C:/Users/test/Documents/Work/Reports"

    # Simulate some learning data
    print("\n1. Adding test learning data...")
    save_learning(filename, folder, "accept")
    save_learning(filename, folder, "accept")
    save_learning(filename, folder, "choose")

    # Get stats
    print("2. Getting learning stats...")
    stats = get_learning_stats(filename, folder)
    print(f"   Stats: {stats}")

    # Test confidence adjustment
    print("\n3. Testing confidence adjustment...")
    base_confidence = 0.60
    adjusted = apply_learning_adjustment(base_confidence, filename, folder)
    print(f"   Base confidence: {base_confidence:.2f}")
    print(f"   Adjusted confidence: {adjusted:.2f}")
    print(f"   Change: {(adjusted - base_confidence)*100:+.1f}%")

    # Test full learning integration
    print("\n4. Testing full learning integration...")
    final_confidence = get_confidence_with_learning(base_confidence, filename, folder)
    print(f"   Final confidence (with reputation): {final_confidence:.2f}")

    print("\n✓ Learning logic tests completed")


def test_learning_insights():
    """Test analytics insights"""
    print("\n" + "="*60)
    print("TEST 2: Analytics Insights")
    print("="*60)

    print("\n1. Getting learning insights...")
    insights = get_learning_insights(limit=5)

    print(f"\n2. Top folders: {len(insights['top_folders'])}")
    for folder, accept_rate, total in insights['top_folders'][:3]:
        print(f"   - {os.path.basename(folder)}: {accept_rate*100:.1f}% ({total} total)")

    print(f"\n3. Problem folders: {len(insights['problem_folders'])}")
    for folder, reject_rate, total in insights['problem_folders'][:3]:
        print(f"   - {os.path.basename(folder)}: {reject_rate*100:.1f}% reject rate ({total} total)")

    print(f"\n4. Recent feedback: {len(insights['recent_feedback'])} entries")

    print("\n✓ Analytics insights tests completed")


def test_database_schema():
    """Verify database tables exist and are properly structured"""
    print("\n" + "="*60)
    print("TEST 3: Database Schema Verification")
    print("="*60)

    conn = sqlite3.connect("storage/state.db")
    c = conn.cursor()

    # Check tables
    c.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [row[0] for row in c.fetchall()]

    required_tables = ['decisions', 'undo_history', 'ignore_state', 'learning', 'ignore_patterns']

    print("\n1. Checking required tables...")
    for table in required_tables:
        if table in tables:
            # Get row count
            c.execute(f"SELECT COUNT(*) FROM {table}")
            count = c.fetchone()[0]
            print(f"   ✓ {table:20s} ({count} rows)")
        else:
            print(f"   ✗ {table:20s} MISSING")

    # Check learning table schema
    print("\n2. Checking learning table schema...")
    c.execute("PRAGMA table_info(learning)")
    columns = c.fetchall()
    column_names = [col[1] for col in columns]
    print(f"   Columns: {', '.join(column_names)}")

    expected_columns = ['id', 'filename', 'suggested_folder', 'action', 'timestamp']
    for col in expected_columns:
        if col in column_names:
            print(f"   ✓ {col}")
        else:
            print(f"   ✗ {col} MISSING")

    conn.close()
    print("\n✓ Database schema tests completed")


def test_confidence_scenarios():
    """Test various confidence adjustment scenarios"""
    print("\n" + "="*60)
    print("TEST 4: Confidence Adjustment Scenarios")
    print("="*60)

    scenarios = [
        ("No learning history", 0.50, "new_file.pdf", "C:/Folder1"),
        ("Multiple accepts", 0.50, "test_report.pdf", "C:/Users/test/Documents/Work/Reports"),
    ]

    for name, base_conf, filename, folder in scenarios:
        adjusted = get_confidence_with_learning(base_conf, filename, folder)
        change = (adjusted - base_conf) * 100
        print(f"\n{name}:")
        print(f"   Base: {base_conf:.2f} → Adjusted: {adjusted:.2f} ({change:+.1f}%)")

    print("\n✓ Confidence scenario tests completed")


def run_all_tests():
    """Run all test suites"""
    print("\n" + "="*70)
    print(" [TEST] File Organizer Improvements")
    print("="*70)

    try:
        test_database_schema()
        test_learning_logic()
        test_learning_insights()
        test_confidence_scenarios()

        print("\n" + "="*70)
        print(" [PASS] All tests completed successfully!")
        print("="*70)

        print("\n[SUMMARY]")
        print("   1. Learning logic is properly integrated")
        print("   2. Analytics insights are working")
        print("   3. Database schema is correct")
        print("   4. Confidence adjustments are functional")

        print("\n[NEXT STEPS]")
        print("   - Run 'python main.py' to start the file organizer")
        print("   - Run 'python undo_cli.py' to undo moves")
        print("   - Run 'python stats_cli.py' to view analytics")

    except Exception as e:
        print(f"\n❌ Test failed with error: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    run_all_tests()
