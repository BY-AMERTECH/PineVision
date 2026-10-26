"""Socket.IO transport for low-latency live detection overlays."""

import threading
from typing import Dict, Optional

from firebase_admin import auth
from flask import request
from flask_socketio import SocketIO, emit, join_room

socketio = SocketIO(async_mode='threading')

_connected_users: Dict[str, str] = {}
_latest_frames: Dict[str, dict] = {}
_state_lock = threading.Lock()


def init_live_socket(app):
    """Attach Socket.IO to Flask and register authenticated scan events."""
    socketio.init_app(app)

    @socketio.on('connect')
    def _on_connect(auth_payload=None):
        token = auth_payload.get('token') if isinstance(auth_payload, dict) else None
        if not token:
            return False

        try:
            decoded = auth.verify_id_token(token)
        except Exception:
            return False

        with _state_lock:
            _connected_users[request.sid] = decoded['uid']
        return True

    @socketio.on('disconnect')
    def _on_disconnect(reason=None):
        with _state_lock:
            _connected_users.pop(request.sid, None)

    @socketio.on('join_live_scan')
    def _on_join_live_scan(data=None):
        scan_id = data.get('scanId') if isinstance(data, dict) else None
        if not isinstance(scan_id, str) or not scan_id.strip():
            return {'ok': False, 'error': 'invalid_scan_id'}

        with _state_lock:
            uid = _connected_users.get(request.sid)
        if not uid:
            return {'ok': False, 'error': 'unauthenticated'}

        try:
            # A socket may join only the live scan created for its Firebase UID.
            from .firebase_client import get_firestore_client
            scan_doc = get_firestore_client().collection('scans').document(scan_id).get()
            scan_data = scan_doc.to_dict() if scan_doc.exists else None
            if not scan_data or scan_data.get('userId') != uid or scan_data.get('status') != 'active':
                return {'ok': False, 'error': 'scan_access_denied'}
        except Exception:
            return {'ok': False, 'error': 'scan_check_failed'}

        room = f'live-scan:{scan_id}'
        join_room(room)

        # Replay the newest frame so joining/reconnecting clients do not have
        # to wait for the next detector iteration to see the overlay.
        with _state_lock:
            latest = _latest_frames.get(scan_id)
        if latest:
            emit('live_detections', latest)

        return {'ok': True}


def emit_live_detections(scan_id: str, frame: dict) -> None:
    """Publish a processed frame and retain one latest snapshot for reconnects."""
    payload = {
        'scanId': scan_id,
        'frame': frame.get('frame'),
        'processedAt': frame.get('processedAt'),
        'd': frame.get('d', []),
    }
    with _state_lock:
        _latest_frames[scan_id] = payload

    try:
        socketio.emit('live_detections', payload, to=f'live-scan:{scan_id}')
    except Exception as exc:
        # A disconnected socket must never interrupt the detector loop.
        print(f"⚠️ Live box socket emit failed: {exc}")


def clear_live_scan(scan_id: Optional[str]) -> None:
    """Discard the cached latest frame when a live scan ends."""
    if not scan_id:
        return
    with _state_lock:
        _latest_frames.pop(scan_id, None)
