#!/usr/bin/env python3
from storage.local_store import load_scopes

scopes = load_scopes()
if not scopes:
    print("❌ NO SCOPES CONFIGURED - App won't find any matching folders!")
else:
    print(f"✓ Found {len(scopes)} scope(s):")
    for scope in scopes:
        print(f"\n  Scope: {scope['name']}")
        print(f"  Root: {scope['root']}")
        print(f"  Folders: {len(scope['folders'])} folders")
        for folder in scope['folders'][:5]:  # Show first 5
            print(f"    - {folder}")
