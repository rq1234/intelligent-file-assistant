#!/usr/bin/env python3
"""
Test script to verify batch UI and intent-based learning flow
"""
import sys
import os

# Add project root to path
sys.path.insert(0, os.path.dirname(__file__))

from storage.local_store import init_db, save_learning, save_ignore
from ui.batch_prompt import display_batch_summary


def test_batch_ui():
    """Test the interactive batch UI with mock data"""
    
    # Initialize database
    init_db()
    print("✓ Database initialized\n")
    
    # Mock data
    auto_moved = [
        ("expense_receipt.pdf", "/home/user/Finance/Receipts"),
    ]
    
    suggestions = [
        ("Q4_Report.docx", "/home/user/Work/Reports", 0.92),
        ("vacation_photo.jpg", "/home/user/Pictures/2024", 0.78),
        ("random_file.txt", "/home/user/Documents", 0.42),
    ]
    
    print("Testing batch UI with:")
    print(f"  • {len(auto_moved)} auto-moved file")
    print(f"  • {len(suggestions)} suggestions")
    print()
    
    # Show UI and collect decisions
    decisions = display_batch_summary(auto_moved, suggestions)
    
    print("\n" + "="*60)
    print("Processing decisions:")
    print("="*60)
    
    # Process decisions to show learning recording
    for filename, (action, folder) in decisions.items():
        if action == "accept":
            print(f"✓ {filename}")
            print(f"  Action: Accept suggestion")
            print(f"  Learning: Positive (boost confidence)")
            
        elif action == "choose":
            print(f"⚠️ {filename}")
            print(f"  Action: Choose different folder")
            print(f"  Target: {folder}")
            print(f"  Learning: Strong negative (model was wrong, decay confidence)")
            
        elif action == "ignore":
            print(f"⊘ {filename}")
            print(f"  Action: Ignore")
            print(f"  Learning: None (don't penalize confidence)")
        print()
    
    print("="*60)
    print("✓ Batch processing complete!")


if __name__ == "__main__":
    test_batch_ui()
