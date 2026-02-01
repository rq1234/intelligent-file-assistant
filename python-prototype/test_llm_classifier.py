#!/usr/bin/env python3
"""
Quick test for LLM classifier
"""
import os
import sys

# Add project root to path
sys.path.insert(0, os.path.dirname(__file__))

from agent.llm_classifier import classify_file


def test_llm_classifier():
    """Test LLM classifier with mock folders"""
    print("=" * 70)
    print(" Testing LLM Classifier")
    print("=" * 70)

    # Create a mock file path (doesn't need to exist for basic test)
    test_file = "IntegerProgrammingTricks.pdf"

    # Mock available folders (from your scopes)
    available_folders = [
        "C:/Users/test/Imperial/Corporate Finance and Capital Markets",
        "C:/Users/test/Imperial/Econometrics 1",
        "C:/Users/test/Imperial/Machine Learning",
        "C:/Users/test/Imperial/Microeconomics 2",
        "C:/Users/test/Imperial/Operations Research",
        "C:/Users/test/Imperial/z_Admin"
    ]

    print(f"\nTest file: {test_file}")
    print(f"Available folders: {len(available_folders)}")
    for folder in available_folders:
        print(f"  - {os.path.basename(folder)}")

    print("\n" + "-" * 70)
    print("Calling LLM classifier...")
    print("-" * 70 + "\n")

    result = classify_file(test_file, available_folders)

    if result:
        print("\n" + "=" * 70)
        print(" LLM Classification Result")
        print("=" * 70)
        print(f"  Folder: {os.path.basename(result['folder'])}")
        print(f"  Confidence: {result['confidence'] * 100:.1f}%")
        print(f"  Reasoning: {result.get('reasoning', 'N/A')}")
        print(f"  Method: {result['method']}")

        # Check if it correctly identified Operations Research
        if "Operations Research" in result['folder']:
            print("\n[SUCCESS] LLM correctly identified Operations Research")
        else:
            print(f"\n[UNEXPECTED] LLM suggested {os.path.basename(result['folder'])}")
            print("  Expected: Operations Research")

    else:
        print("\n[FAIL] LLM classification failed or returned None")
        print("  Check:")
        print("  1. API key is valid in config/settings.yaml")
        print("  2. OpenAI package is installed: pip install openai")
        print("  3. Internet connection is working")

    print("\n" + "=" * 70)


if __name__ == "__main__":
    test_llm_classifier()
