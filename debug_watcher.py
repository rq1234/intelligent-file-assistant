#!/usr/bin/env python3
"""Debug watchdog event detection"""
import os
import time
from pathlib import Path

downloads = Path("C:/Users/rongq/Downloads")

print(f"Checking downloads: {downloads}")
print(f"Exists: {downloads.exists()}\n")

# List all files
print("Files currently in Downloads:")
for file in sorted(downloads.glob("*"), key=lambda x: x.stat().st_mtime, reverse=True)[:5]:
    if file.is_file():
        mtime = time.time() - file.stat().st_mtime
        print(f"  {file.name:40} - {mtime:.1f}s ago ({file.stat().st_size} bytes)")

# Test matching
test_file = downloads / "Microeconomics_test.txt"
print(f"\nTest file exists: {test_file.exists()}")

# Now test the matching engine
print("\nTesting matcher...")
from agent.matcher import match
from storage.local_store import load_scopes

scopes = load_scopes()
print(f"Loaded {len(scopes)} scope(s)")
for scope in scopes:
    print(f"  Scope: {scope['name']}")
    print(f"  Root: {scope['root']}")

if test_file.exists():
    result = match(str(test_file), scopes)
    print(f"\nMatch result for {test_file.name}:")
    print(f"  Folder: {result['folder']}")
    print(f"  Confidence: {result['confidence']:.2f}")
    print(f"  Token score: {result['token_score']:.2f}")
    print(f"  Fuzzy score: {result['fuzzy_score']:.2f}")
    print(f"  Content score: {result['content_score']:.2f}")
else:
    print(f"\n❌ Test file not found at {test_file}")
