"""
Flask Blueprint: /api/drone/*
Exposes the drone stream connection and health-check endpoints.
"""

import json
import logging
import os
import re
import tempfile

from flask import Blueprint, request, jsonify, send_file
from werkzeug.utils import secure_filename
from . import service
from .detection import get_detector, ScanInProgressError
from .firebase_client import _UPLOADS_DIR

log = logging.getLogger(__name__)

drone_bp = Blueprint('drone', __name__, url_prefix='/api/drone')


@drone_bp.route('/prepare', methods=['POST'])
def prepare():
    """
    POST /api/drone/prepare

    Called when the user opens the Connect Drone modal.
    1. Auto-starts MediaMTX if not already running.
    2. Detects the machine's local IPv4 address.
    3. Returns the RTMP URL to pre-fill in the frontend.
    """
    from . import process_manager, network

    # Step 1 — ensure MediaMTX is up
    log.info('Prepare: ensuring MediaMTX is running...')
    mtx = process_manager.ensure_running()
    if not mtx['ok']:
        log.error('Prepare: MediaMTX failed — %s', mtx['message'])
        return jsonify({
            'ok':      False,
            'error':   mtx['error'],
            'message': mtx['message'],
        }), 500

    # Step 2 — detect local IPv4s (all interfaces so user can pick the right one)
    log.info('Prepare: detecting local IPv4s...')
    all_ips = network.get_all_local_ipv4s()
    ip      = all_ips[0]   # primary / best-guess

    # Step 3 — build RTMP URL
    rtmp_url = f'rtmp://{ip}:1935/pinevision_scan'
    log.info('Prepare: RTMP URL = %s | all IPs = %s', rtmp_url, all_ips)

    return jsonify({
        'ok':               True,
        'rtmp_url':         rtmp_url,
        'ip':               ip,
        'all_ips':          all_ips,
        'mediamtx_started': mtx.get('started', False),
    }), 200


@drone_bp.route('/connect', methods=['POST'])
def connect():
    """
    POST /api/drone/connect
    Body: { "rtmp_url": "rtmp://HOST:PORT/PATH" }

    Validates the RTMP URL, queries MediaMTX to confirm the drone is live,
    and returns the HLS playback URL on success.
    """
    body     = request.get_json(silent=True) or {}
    rtmp_url = (body.get('rtmp_url') or '').strip()

    if not rtmp_url:
        log.warning('connect: missing rtmp_url — body=%r', body)
        return jsonify({
            'ok':      False,
            'error':   'missing_url',
            'message': 'rtmp_url is required in the request body.',
        }), 400

    log.info('connect: rtmp_url=%s', rtmp_url)
    result = service.connect(rtmp_url)

    if result['ok']:
        log.info('connect: success — hls_url=%s', result.get('hls_url'))
    else:
        log.warning('connect: failed — error=%s | %s',
                    result.get('error'), result.get('message'))

    return jsonify(result), 200 if result['ok'] else 400


@drone_bp.route('/status', methods=['GET'])
def status():
    """
    GET /api/drone/status?path=STREAM_PATH

    Returns whether MediaMTX reports the given path as ready (publisher active).
    Called periodically by the frontend to detect stream drops.
    """
    path_name = (request.args.get('path') or '').strip()

    if not path_name:
        return jsonify({
            'ok':      False,
            'error':   'missing_path',
            'message': 'path query parameter is required.',
        }), 400

    return jsonify(service.status(path_name)), 200

# ═══════════════════════════════════════════════════════════
# NEW DETECTION ENDPOINTS
# ═══════════════════════════════════════════════════════════

@drone_bp.route('/start-detection', methods=['POST'])
def start_detection():
    """
    POST /api/drone/start-detection
    Body: {
        "hls_url": "http://localhost:8888/stream/index.m3u8",
        "block_id": "Ka9QfsVyjfOJ4U7xIlxt",
        "user_id": "ojoNzJsvnecrRgt8mn7HBbajmYJ2",
        "fps": 1  // optional, default 1
    }

    Starts real-time YOLO detection with DeepSORT tracking.
    Returns scan session ID.
    """
    body = request.get_json(silent=True) or {}
    
    hls_url = (body.get('hls_url') or '').strip()
    block_id = (body.get('block_id') or '').strip()
    user_id = (body.get('user_id') or '').strip()
    fps = body.get('fps', 1)
    
    # Validation
    if not hls_url:
        return jsonify({
            'ok': False,
            'error': 'missing_hls_url',
            'message': 'hls_url is required'
        }), 400
    
    if not block_id:
        return jsonify({
            'ok': False,
            'error': 'missing_block_id',
            'message': 'block_id is required'
        }), 400
    
    if not user_id:
        return jsonify({
            'ok': False,
            'error': 'missing_user_id',
            'message': 'user_id is required'
        }), 400
    
    # Get detector instance
    detector = get_detector()

    # Start detection
    try:
        scan_id = detector.start_detection(
            hls_url=hls_url,
            block_id=block_id,
            user_id=user_id,
            fps=fps
        )
    except ScanInProgressError as e:
        log.warning('start-detection: rejected — %s', e)
        return jsonify({
            'ok': False,
            'error': 'scan_in_progress',
            'message': str(e),
        }), 409

    if scan_id:
        return jsonify({
            'ok': True,
            'scan_id': scan_id,
            'message': 'Detection started successfully'
        }), 200
    else:
        return jsonify({
            'ok': False,
            'error': 'detection_failed',
            'message': 'Failed to start detection'
        }), 500


@drone_bp.route('/stop-detection', methods=['POST'])
def stop_detection():
    """
    POST /api/drone/stop-detection
    Body: {
        "block_id": "Ka9QfsVyjfOJ4U7xIlxt",
        "scan_id": "scan_abc123"
    }

    Stops detection and finalizes the scan session.
    """
    body = request.get_json(silent=True) or {}

    block_id = (body.get('block_id') or '').strip()
    scan_id  = (body.get('scan_id')  or '').strip()
    user_id  = (body.get('user_id')  or '').strip()

    if not block_id or not scan_id:
        return jsonify({
            'ok': False,
            'error': 'missing_parameters',
            'message': 'block_id and scan_id are required'
        }), 400

    # Get detector instance
    detector = get_detector()

    # Stop detection — pass user_id so created alerts get the userId field
    success = detector.stop_detection(block_id, scan_id, user_id=user_id)
    
    if success:
        return jsonify({
            'ok': True,
            'message': 'Detection stopped and scan completed'
        }), 200
    else:
        return jsonify({
            'ok': False,
            'error': 'stop_failed',
            'message': 'Failed to stop detection'
        }), 500


@drone_bp.route('/upload-video', methods=['POST'])
def upload_video():
    """
    POST /api/drone/upload-video
    Multipart form: file (MP4), block_id, user_id, frame_skip (optional, default 2)

    Saves the video to a temp directory, starts an async background scan,
    and returns {ok, scan_id} immediately so the frontend can play the
    video locally while the backend processes frames.
    """
    if 'file' not in request.files:
        return jsonify({'ok': False, 'message': 'No file provided'}), 400

    f = request.files['file']
    if not f.filename:
        return jsonify({'ok': False, 'message': 'Empty filename'}), 400

    if not f.filename.lower().endswith('.mp4'):
        return jsonify({'ok': False, 'message': 'Only MP4 files are accepted'}), 400

    block_id = (request.form.get('block_id') or '').strip()
    user_id  = (request.form.get('user_id')  or '').strip()
    # Default (5) matches the stride PineappleDetector.start_video_scan()
    # itself defaults to, and what this endpoint always used in practice
    # until now (see Issue C: this value used to be parsed and then
    # discarded in favor of a hardcoded 5 below). The frontend doesn't
    # currently send frame_skip, so this default is what actually runs
    # today; keeping it here preserves that behavior while making the field
    # genuinely configurable for any future caller that does send it.
    try:
        frame_skip = int(request.form.get('frame_skip', 5))
    except (ValueError, TypeError):
        frame_skip = 5
    frame_skip = max(1, frame_skip)  # guard against 0/negative -> ZeroDivisionError downstream

    if not block_id or not user_id:
        return jsonify({
            'ok': False,
            'message': 'block_id and user_id are required',
        }), 400

    uploads_dir = os.path.join(tempfile.gettempdir(), 'pinevision_uploads')
    os.makedirs(uploads_dir, exist_ok=True)

    safe_name  = secure_filename(f.filename)
    video_path = os.path.join(uploads_dir, safe_name)
    f.save(video_path)
    log.info('upload-video: saved %s (%d bytes)', video_path, os.path.getsize(video_path))

    try:
        detector = get_detector()
    except Exception:
        log.exception('upload-video: detector initialization failed')
        return jsonify({
            'ok':      False,
            'message': 'Detection model failed to initialize. Check server logs.',
        }), 503

    try:
        scan_id = detector.start_video_scan(
            video_path=video_path,
            block_id=block_id,
            user_id=user_id,
            process_every_n_frames=frame_skip,
            update_interval=2.0,
        )
    except ScanInProgressError as e:
        log.warning('upload-video: rejected — %s', e)
        # Clean up the temp file we just saved — no scan will process it.
        try:
            os.remove(video_path)
        except OSError:
            pass
        return jsonify({
            'ok': False,
            'error': 'scan_in_progress',
            'message': str(e),
        }), 409

    if not scan_id:
        return jsonify({'ok': False, 'message': 'Failed to start video scan'}), 500

    return jsonify({'ok': True, 'scan_id': scan_id}), 200


@drone_bp.route('/scan/<scan_id>/manifest', methods=['GET'])
def get_scan_manifest(scan_id):
    """
    GET /api/drone/scan/<scan_id>/manifest

    Returns the detection manifest JSON for a completed MP4 scan.
    The manifest contains timestamped bounding-box data for every processed
    frame, ready for the frontend to load into BboxOverlay for synchronized
    1× playback.

    Security:
    - scan_id is validated against the expected Firestore auto-ID format
      (20 alphanumeric characters) — no path traversal possible.
    - The manifest file is only ever written to _UPLOADS_DIR by the backend;
      we never expose arbitrary filesystem paths to the client.
    """
    # Firestore auto-IDs are exactly 20 URL-safe alphanumeric characters.
    # Reject anything that doesn't match — prevents any path traversal.
    if not re.fullmatch(r'[A-Za-z0-9]{10,30}', scan_id):
        return jsonify({'ok': False, 'error': 'invalid_scan_id'}), 400

    manifest_path = os.path.join(_UPLOADS_DIR, f'{scan_id}_manifest.json')

    if not os.path.isfile(manifest_path):
        return jsonify({'ok': False, 'error': 'manifest_not_found',
                        'message': 'Manifest not ready yet or scan not found.'}), 404

    try:
        with open(manifest_path, 'r', encoding='utf-8') as fh:
            data = json.load(fh)
        log.info('manifest: served %s (%d frames)', scan_id, len(data.get('frames', [])))
        return jsonify(data), 200
    except Exception:
        log.exception('manifest: failed to read %s', manifest_path)
        return jsonify({'ok': False, 'error': 'manifest_read_error'}), 500


@drone_bp.route('/video-time', methods=['POST'])
def video_time():
    """
    POST /api/drone/video-time
    Body: { "scan_id": "...", "current_time": 12.5, "ended": false }

    Receives the frontend video element's currentTime and forwards it to the
    time-synced scan loop so the backend processes frames that correspond
    to what the user is actually watching.
    """
    body        = request.get_json(silent=True) or {}
    scan_id     = (body.get('scan_id') or '').strip()
    current_time = body.get('current_time', 0)
    is_ended    = bool(body.get('ended', False))

    if not scan_id:
        return jsonify({'ok': False, 'message': 'scan_id is required'}), 400

    try:
        current_time = float(current_time)
    except (TypeError, ValueError):
        return jsonify({'ok': False, 'message': 'current_time must be a number'}), 400

    detector = get_detector()
    detector.push_video_time(scan_id, current_time, is_ended)
    return jsonify({'ok': True}), 200