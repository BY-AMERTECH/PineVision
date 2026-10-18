"""
Firebase Admin SDK client for real-time detection updates.

KEY FIX: No longer calls firebase_admin.initialize_app() itself.
app.py already initializes the default Firebase app on server start.
This module simply obtains a client from the already-initialized app.
If run standalone (e.g. testing detection.py directly), it will
initialize using serviceAccountKey.json as a fallback.
"""

import json
import os
import tempfile
from datetime import date
import firebase_admin
from firebase_admin import credentials, firestore
from typing import Optional

# Directory where temp MP4 uploads and detection manifests are stored.
_UPLOADS_DIR = os.path.join(tempfile.gettempdir(), 'pinevision_uploads')

_db = None


def create_crop_cycle(block_id: str, user_id: str, planting_date: str, forcing_date: str = '') -> str:
    """Seed a legacy block's current cycle without changing its scan metrics.

    Used by the explicit crop-cycle migration utility. The transaction makes
    the cycle document and the block's active-cycle pointer visible together.
    Existing scan documents are intentionally not assigned to this cycle.
    """
    try:
        planting = date.fromisoformat(str(planting_date))
    except (TypeError, ValueError):
        raise ValueError('Planting date must be stored as an ISO date (YYYY-MM-DD).')
    forcing_text = str(forcing_date or '')
    if forcing_text:
        try:
            forcing = date.fromisoformat(forcing_text)
        except ValueError:
            raise ValueError('Forcing date must be stored as an ISO date (YYYY-MM-DD).')
        if forcing < planting:
            raise ValueError('Forcing date cannot be before planting date.')

    db = get_firestore_client()
    block_ref = db.collection('blocks').document(block_id)
    cycle_ref = block_ref.collection('cycles').document()
    transaction = db.transaction()

    @firestore.transactional
    def seed_cycle(txn):
        block_snapshot = txn.get(block_ref)
        if not block_snapshot.exists:
            raise ValueError('Block not found.')
        block_data = block_snapshot.to_dict() or {}
        if user_id and block_data.get('userId') != user_id:
            raise ValueError('Block owner changed; migration was skipped.')
        existing_cycles = list(txn.get(block_ref.collection('cycles').limit(1)))
        if block_data.get('activeCycleId') or block_data.get('latestCycleId') or existing_cycles:
            raise ValueError('Block already has crop-cycle history.')

        metrics = {
            'bearingPercent': block_data.get('bearingPercent', 0) or 0,
            'nonBearingPercent': block_data.get('nonBearingPercent', 0) or 0,
            'nonViable': block_data.get('nonViable', 0) or 0,
            'totalPlantEstimate': block_data.get('totalPineapples', 0) or 0,
            'plantCount': block_data.get('totalPineapples', 0) or 0,
            'estimatedBearing': block_data.get('estimatedBearing', 0) or 0,
            'estimatedNonBearing': block_data.get('estimatedNonBearing', 0) or 0,
            'detectionCoverage': block_data.get('detectionCoverage', 0) or 0,
            'scanCount': 0,
            'awaitingFirstScan': not bool(block_data.get('lastScanned')),
        }
        now = firestore.SERVER_TIMESTAMP
        txn.set(cycle_ref, {
            'plantingDate': str(planting_date),
            'forcingDate': forcing_text,
            'daf': block_data.get('daf', 0) or 0,
            'status': 'active',
            'legacy': True,
            'migratedAt': now,
            'updatedAt': now,
            'metrics': metrics,
        })
        txn.update(block_ref, {
            'activeCycleId': cycle_ref.id,
            'latestCycleId': cycle_ref.id,
            'cropCycleSchemaInitialized': True,
        })

    seed_cycle(transaction)
    return cycle_ref.id


def get_firestore_client():
    """
    Return the Firestore client, reusing the app that app.py already
    initialized. If no app exists yet (standalone / test mode), initializes
    one using serviceAccountKey.json in the backend/ directory.

    Called by every helper below, so we only pay the initialization cost once.
    """
    global _db
    if _db is not None:
        return _db

    if firebase_admin._apps:
        # Normal path: app.py already ran firebase_admin.initialize_app()
        _db = firestore.client()
    else:
        # Standalone / test path: running detection.py directly without app.py
        key_path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)),
            'serviceAccountKey.json'
        )
        if not os.path.exists(key_path):
            raise FileNotFoundError(
                f"Firebase service account not found: {key_path}\n"
                "Download it from Firebase Console and place it in backend/."
            )
        cred = credentials.Certificate(key_path)
        firebase_admin.initialize_app(cred)
        _db = firestore.client()
        print("✅ Firebase initialized (standalone mode)")

    return _db


# ═══════════════════════════════════════════════════════════════════════
# OPTIMIZED: BATCH WRITE — replaces two separate round-trips with one
# ═══════════════════════════════════════════════════════════════════════

def update_detection_batch(
    block_id: str,
    scan_id: str,
    bearing_count: int,
    non_bearing_count: int,
    non_viable_count: int,
    total_count: int,
    scan_progress: float = 0.0,
    processed_frames: int = 0,
    total_frames: int = 0,
    live_frame: Optional[dict] = None,
) -> bool:
    """
    Update both block stats AND scan analysis progress in a single Firestore
    batch commit.

    scan_progress: 0–100 percentage of video frames already processed.
    processed_frames / total_frames: raw frame counts for the progress display.

    NOTE: recentFrames is no longer written to Firestore for MP4 analysis.
    Live HLS analysis can publish its newest processed frame in live_frame.
    Detection bounding
    boxes are now accumulated locally and written as a single manifest JSON
    file when analysis is complete. The frontend fetches that manifest via
    GET /api/drone/scan/<scan_id>/manifest and uses it for synchronized
    overlay rendering at normal 1× playback speed.
    """
    try:
        db = get_firestore_client()

        bearing_pct     = (bearing_count     / total_count * 100) if total_count > 0 else 0.0
        non_bearing_pct = (non_bearing_count / total_count * 100) if total_count > 0 else 0.0
        non_viable_pct  = (non_viable_count  / total_count * 100) if total_count > 0 else 0.0

        batch = db.batch()

        # Write 1 — block aggregate stats (drives live stats panel)
        block_ref = db.collection('blocks').document(block_id)
        block_update = {
            'bearingPercent':    round(bearing_pct,     1),
            'nonBearingPercent': round(non_bearing_pct, 1),
            'nonViable':         round(non_viable_pct,  1),
            'totalPineapples':   total_count,
            'lastUpdate':        firestore.SERVER_TIMESTAMP,
        }
        if live_frame is not None:
            block_update['liveDetections'] = live_frame
        batch.update(block_ref, block_update)

        # Write 2 — scan progress for frontend progress bar only (no recentFrames)
        scan_ref = db.collection('scans').document(scan_id)
        scan_update = {
            'bearing':          bearing_count,
            'nonBearing':       non_bearing_count,
            'nonViable':        non_viable_count,
            'total':            total_count,
            'scanProgress':     round(scan_progress, 1),
            'processedFrames':  processed_frames,
            'totalFrames':      total_frames,
            'lastUpdate':       firestore.SERVER_TIMESTAMP,
        }
        batch.update(scan_ref, scan_update)

        batch.commit()
        return True

    except Exception as e:
        print(f"❌ Error in detection batch update: {e}")
        return False


def save_detection_manifest(scan_id: str, manifest_data: dict) -> Optional[str]:
    """
    Write the detection manifest as a JSON file to the uploads temp directory.

    The manifest is read by GET /api/drone/scan/<scan_id>/manifest and then
    loaded into the frontend's BboxOverlay for synchronized 1× playback.

    Returns the file path on success, None on failure.
    """
    try:
        os.makedirs(_UPLOADS_DIR, exist_ok=True)
        path = os.path.join(_UPLOADS_DIR, f'{scan_id}_manifest.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(manifest_data, fh, separators=(',', ':'))
        print(f"✅ Manifest written: {path} ({os.path.getsize(path):,} bytes)")
        return path
    except Exception as e:
        print(f"❌ Failed to write manifest: {e}")
        return None


# ═══════════════════════════════════════════════════════════════════════
# SCAN SESSION LIFECYCLE
# ═══════════════════════════════════════════════════════════════════════

def create_scan_session(block_id: str, user_id: str) -> Optional[str]:
    """Create a new scan session document. Returns the generated scan ID."""
    try:
        db = get_firestore_client()
        scan_ref = db.collection('scans').document()
        block_snapshot = db.collection('blocks').document(block_id).get()
        block_data = block_snapshot.to_dict() if block_snapshot.exists else {}
        scan_data = {
            'blockId':         block_id,
            'userId':          user_id,
            'status':          'active',
            'startTime':       firestore.SERVER_TIMESTAMP,
            'bearing':         0,
            'nonBearing':      0,
            'nonViable':       0,
            'total':           0,
            'scanProgress':    0,
            'processedFrames': 0,
            'totalFrames':     0,
            'manifestReady':   False,
            'lastUpdate':      firestore.SERVER_TIMESTAMP,
        }
        # New scans are associated only with the current cycle at scan start;
        # existing scans are never retroactively assigned.
        if block_data.get('activeCycleId'):
            scan_data['cropCycleId'] = block_data['activeCycleId']
        scan_ref.set(scan_data)
        print(f"✅ Created scan session: {scan_ref.id}")
        return scan_ref.id
    except Exception as e:
        print(f"❌ Error creating scan session: {e}")
        return None


def get_scan_status(scan_id: str) -> Optional[str]:
    """
    Return the current 'status' field of a scan document, or None if the
    document doesn't exist or couldn't be read.

    Used by PineappleDetector.stop_detection() to check whether a scan's
    background loop already wrote a terminal status (e.g. 'failed', for a
    video scan interrupted mid-analysis) before potentially overwriting it
    with a fabricated 'completed' status. See Issue A in the drone-pipeline
    investigation.
    """
    try:
        db = get_firestore_client()
        doc = db.collection('scans').document(scan_id).get()
        if doc.exists:
            return doc.to_dict().get('status')
        return None
    except Exception as e:
        print(f"⚠️ Could not fetch scan status for {scan_id}: {e}")
        return None


def get_block_population(block_id: str) -> int:
    """Return the registered pineapple population for a block, or 0 if unset."""
    try:
        db = get_firestore_client()
        doc = db.collection('blocks').document(block_id).get()
        if doc.exists:
            return int(doc.to_dict().get('population', 0) or 0)
        return 0
    except Exception as e:
        print(f"⚠️ Could not fetch block population: {e}")
        return 0


def complete_scan_session(
    scan_id: str,
    block_id: str,
    bearing_count: int,
    non_bearing_count: int,
    non_viable_count: int,
    total_count: int,
    registered_population: int = 0,
    estimated_bearing: int = 0,
    estimated_non_bearing: int = 0,
    detection_coverage: float = 0.0,
) -> bool:
    """
    Mark the scan as completed and increment the block's totalScans counter.
    Uses a batch write so both documents update atomically.

    Optional population-estimation fields (estimated_bearing,
    estimated_non_bearing, detection_coverage) are written when provided.
    """
    try:
        db = get_firestore_client()

        bearing_pct     = (bearing_count     / total_count * 100) if total_count > 0 else 0.0
        non_bearing_pct = (non_bearing_count / total_count * 100) if total_count > 0 else 0.0
        non_viable_pct  = (non_viable_count  / total_count * 100) if total_count > 0 else 0.0

        batch = db.batch()

        scan_ref = db.collection('scans').document(scan_id)
        batch.update(scan_ref, {
            'status':                'completed',
            'endTime':               firestore.SERVER_TIMESTAMP,
            'bearing':               bearing_count,
            'nonBearing':            non_bearing_count,
            'nonViable':             non_viable_count,
            'total':                 total_count,
            'scanProgress':          100,
            'bearingPercent':        round(bearing_pct,     1),
            'nonBearingPercent':     round(non_bearing_pct, 1),
            'nonViablePercent':      round(non_viable_pct,  1),
            'registeredPopulation':  registered_population,
            'estimatedBearing':      estimated_bearing,
            'estimatedNonBearing':   estimated_non_bearing,
            'detectionCoverage':     round(detection_coverage, 2),
            'manifestReady':         True,
        })

        block_ref = db.collection('blocks').document(block_id)
        batch.update(block_ref, {
            'totalScans':            firestore.Increment(1),
            'lastScanned':           firestore.SERVER_TIMESTAMP,
            'bearingPercent':        round(bearing_pct, 1),
            'nonBearingPercent':     round(non_bearing_pct, 1),
            'nonViable':             round(non_viable_pct, 1),
            'totalPineapples':       total_count,
            'estimatedBearing':      estimated_bearing,
            'estimatedNonBearing':   estimated_non_bearing,
            'detectionCoverage':     round(detection_coverage, 2),
            'awaitingFirstScan':     False,
        })

        scan_snapshot = scan_ref.get()
        scan_data = scan_snapshot.to_dict() if scan_snapshot.exists else {}
        cycle_id = (scan_data or {}).get('cropCycleId')
        if cycle_id:
            cycle_ref = block_ref.collection('cycles').document(cycle_id)
            if cycle_ref.get().exists:
                batch.update(cycle_ref, {
                    'metrics.bearingPercent': round(bearing_pct, 1),
                    'metrics.nonBearingPercent': round(non_bearing_pct, 1),
                    'metrics.nonViable': round(non_viable_pct, 1),
                    'metrics.bearingCount': bearing_count,
                    'metrics.nonBearingCount': non_bearing_count,
                    'metrics.nonViableCount': non_viable_count,
                    'metrics.plantCount': total_count,
                    'metrics.totalPlantEstimate': bearing_count + non_bearing_count,
                    'metrics.estimatedBearing': estimated_bearing,
                    'metrics.estimatedNonBearing': estimated_non_bearing,
                    'metrics.detectionCoverage': round(detection_coverage, 2),
                    'metrics.awaitingFirstScan': False,
                    'metrics.scanCount': firestore.Increment(1),
                    'metrics.lastScanned': firestore.SERVER_TIMESTAMP,
                    'updatedAt': firestore.SERVER_TIMESTAMP,
                })

        batch.commit()
        print(f"✅ Scan session completed: {scan_id}")
        return True

    except Exception as e:
        print(f"❌ Error completing scan session: {e}")
        return False


# ═══════════════════════════════════════════════════════════════════════
# LEGACY SINGLE-WRITE HELPERS (kept for backward compatibility)
# The detection loop now uses update_detection_batch() above instead.
# ═══════════════════════════════════════════════════════════════════════

def update_block_stats(
    block_id: str,
    bearing_count: int,
    non_bearing_count: int,
    non_viable_count: int,
    total_count: int
) -> bool:
    """Single-document block stats write. Prefer update_detection_batch()."""
    try:
        db = get_firestore_client()
        bearing_pct     = (bearing_count     / total_count * 100) if total_count > 0 else 0.0
        non_bearing_pct = (non_bearing_count / total_count * 100) if total_count > 0 else 0.0
        non_viable_pct  = (non_viable_count  / total_count * 100) if total_count > 0 else 0.0

        db.collection('blocks').document(block_id).update({
            'bearingPercent':    round(bearing_pct,     1),
            'nonBearingPercent': round(non_bearing_pct, 1),
            'nonViable':         round(non_viable_pct,  1),
            'totalPineapples':   total_count,
            'lastUpdate':        firestore.SERVER_TIMESTAMP,
        })
        return True
    except Exception as e:
        print(f"❌ Error updating block stats: {e}")
        return False


def update_scan_progress(
    scan_id: str,
    bearing_count: int,
    non_bearing_count: int,
    non_viable_count: int,
    total_count: int
) -> bool:
    """Single-document scan progress write. Prefer update_detection_batch()."""
    try:
        db = get_firestore_client()
        db.collection('scans').document(scan_id).update({
            'bearing':    bearing_count,
            'nonBearing': non_bearing_count,
            'nonViable':  non_viable_count,
            'total':      total_count,
            'lastUpdate': firestore.SERVER_TIMESTAMP,
        })
        return True
    except Exception as e:
        print(f"❌ Error updating scan progress: {e}")
        return False
