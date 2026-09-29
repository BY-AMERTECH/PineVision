---
name: pinevision-detection-pipeline
description: Use when changing or debugging PineVision YOLO/DeepSORT detection, scan lifecycle, RTMP/HLS/RTSP streams, MediaMTX, MP4 scanning, or scan-related Firestore data.
---

# PineVision detection and scan workflow

Read `AGENTS.md` and the Detection pipeline section of `llm-context/knowledge.md` before editing. This skill records fragile system invariants; confirm details in current source when uncertain.

## Trace the full path

Follow the affected flow through the relevant code instead of editing an isolated layer:

- API and request validation: `backend/drone_conn/routes.py`.
- RTMP validation and stream health: `service.py`, `mediamtx.py`, and `process_manager.py`.
- Frame capture and reconnects: `stream_capture.py`.
- YOLO/DeepSORT inference, scan loops, status transitions, and alert thresholds: `detection.py`.
- Scan/block persistence: `firebase_client.py`.
- Live progress and manifest display: `frontend/js/drone-view.js` and the relevant role page.

Read the full functions and callers on the path. Preserve the existing request/response contract unless the user asks to change it.

## Preserve these invariants

- Only one scan runs at a time; a competing start is rejected with HTTP 409.
- Scan status progresses from `active` to a terminal state (`completed` or `failed`); stopping must not overwrite a terminal state.
- Uploaded-video manifests must be saved successfully before completion marks `manifestReady=True`.
- Count confirmed DeepSORT tracks only, with each track's category fixed when first confirmed.
- Route scan/block writes through `firebase_client.py`. Existing exceptions include failed-status updates and the alert batch in `detection.py`; inspect the current implementation before deciding whether a write is an exception.
- Never describe the model as a specific YOLO version without checking the active model-loading path.

## Verification and side effects

- Detection CLI and `backend/test_video_firebase.py` write to live Firestore. Do not run them without the user's explicit request.
- The app requires the real, local `backend/serviceAccountKey.json`, model weights, and sometimes MediaMTX. Never print credentials, create placeholders, or inspect the large model/media binaries.
- For changes that cannot be exercised safely, perform static review and state the unrun verification clearly. Do not claim automated tests pass; this repo has no automated test suite.
