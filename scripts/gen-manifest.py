#!/usr/bin/env python3
"""Generate public/csv/property-manifest.json from property CSV files.

Includes all CSVs except TEA rating files.
"""
import json
from pathlib import Path

ROOT = Path('public/csv')
MANIFEST = ROOT / 'property-manifest.json'

paths = []
for p in sorted(ROOT.rglob('*.csv')):
    rel = '/csv/' + p.relative_to(ROOT).as_posix()
    # Never include TEA rating files
    if 'TEA_' in p.name:
        continue
    
    paths.append(rel)

MANIFEST.write_text(json.dumps(paths, indent=2), encoding='utf-8')
print(f'Wrote {len(paths)} entries to {MANIFEST}')
