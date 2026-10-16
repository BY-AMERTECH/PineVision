"""Idempotently seed one active cycle from each legacy block's current dates.

Run from backend/ with its real serviceAccountKey.json. Default is a dry run;
pass --apply only after reviewing the printed counts and backing up Firestore.
Historical scans are intentionally left unassigned because the legacy schema
cannot prove which production run was active at each scan time.
"""
import argparse
import os

import firebase_admin
from firebase_admin import credentials, firestore


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true', help='Write eligible legacy cycles to Firestore.')
    args = parser.parse_args()

    key_path = os.path.join(os.path.dirname(__file__), 'serviceAccountKey.json')
    if not os.path.isfile(key_path):
        raise SystemExit('Missing backend/serviceAccountKey.json; no migration was run.')
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(key_path))
    db = firestore.client()
    # Project only fields needed for the summary; avoid loading scan evidence
    # or unrelated block/account data into the migration process.
    blocks = list(db.collection('blocks').select(
        ['activeCycleId', 'planted', 'forcingDate', 'userId']).stream())
    scans = db.collection('scans').select(['cycleId']).stream()
    eligible, already_linked, missing_dates = [], 0, 0
    for block in blocks:
        data = block.to_dict() or {}
        if data.get('activeCycleId'):
            already_linked += 1
        elif data.get('planted'):
            eligible.append((block.id, data.get('planted'), data.get('forcingDate') or '', data.get('userId') or 'migration'))
        else:
            missing_dates += 1

    print('Crop cycle migration summary' + (' (APPLY)' if args.apply else ' (DRY RUN)'))
    print(f'Blocks inspected: {len(blocks)}', flush=True)
    print(f'Cycles to create: {len(eligible)}')
    print(f'Blocks already linked: {already_linked}')
    print(f'Blocks skipped (no reliable planting date): {missing_dates}')
    unassigned_scans = 0
    total_scans = 0
    for scan in scans:
        total_scans += 1
        if not (scan.to_dict() or {}).get('cycleId'):
            unassigned_scans += 1
    print(f'Scans inspected: {total_scans}', flush=True)
    print(f'Historical scans left unassigned: {unassigned_scans}')
    if not args.apply:
        print('No data changed. Re-run with --apply only after backup and review.')
        return

    from drone_conn.firebase_client import create_crop_cycle
    created = skipped = 0
    for block_id, planting, forcing, creator in eligible:
        try:
            create_crop_cycle(block_id, creator, str(planting), str(forcing))
            created += 1
        except ValueError:
            # Active cycle may have been created after the inventory read.
            skipped += 1
    print(f'Cycles created: {created}; skipped after concurrent changes: {skipped}')
    print('Historical scans remain unassigned and require manual evidence-based review.')


if __name__ == '__main__':
    main()
