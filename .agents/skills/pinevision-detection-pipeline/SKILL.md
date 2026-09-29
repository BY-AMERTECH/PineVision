---
name: pinevision-detection-pipeline
description: Use when changing or debugging YOLO/DeepSORT detection, the scan lifecycle (start/stop/progress/completion), stream capture or MediaMTX wiring, or the Firestore scans/blocks/monitoring_alerts writes in backend/drone_conn.
---

# PineVision — Detection Pipeline & Scan Lifecycle

Background: [`knowledge.md`](../../../llm-context/knowledge.md), conventions:
[`AGENTS.md`](../../../llm-context/AGENTS.md). Facts below were read from current source.

## When to use this skill

Any task touching `backend/drone_conn/{detection,firebase_client,stream_capture,routes,service,mediamtx,process_manager}.py`:
detection behavior, scan state transitions, stream health, MP4 upload scanning,
manifests, or alert generation.

## Flow: input → detection → scan lifecycle → Firestore

```
Live:  DJI drone --RTMP--> MediaMTX (:1935 in, HLS :8888 / RTSP :8554 out,
       control API :9997)                    process_manager.ensure_running()
          |                                  auto-starts mediamtx.exe with
          v                                  mediamtx/mediamtx.yml
POST /api/drone/prepare → /connect (service.connect validates the RTMP URL,
       checks the path is ready via mediamtx.get_path(), returns HLS URL)
          |
          v
POST /api/drone/start-detection → get_detector().start_detection()
          |                               (singleton, _scan_lock-guarded;
          |                                second scan raises ScanInProgressError
          |                                → routes.py returns HTTP 409)
          v
HLSStreamCapture (stream_capture.py): polls the m3u8 playlist
       (_wait_for_playlist), derives RTSP from the HLS URL
       (_derive_rtsp_url) and prefers RTSP-over-TCP, falls back to HLS;
       capture thread enqueues frames at `fps` into Queue(maxsize=10),
       drops stale frames, reconnects after 30 consecutive read failures
       (max 5 reconnects)
          |
          v  frames
PineappleDetector.detect_frame(): resize to _INFERENCE_SIZE=640 →
       YOLO inference → DeepSort.update_tracks() (max_age=30, n_init=3,
       max_iou_distance=0.7) → count only is_confirmed() tracks;
       track_categories locks each track's class at first confirmation
       (prevents cross-category double counting); unique_ids holds
       per-category sets: bearing / non_bearing / non_viable
          |
          v  every update_interval (2.0s), fire-and-forget daemon thread
update_detection_batch() — ONE batch: blocks doc (bearingPercent,
       nonBearingPercent, nonViable, totalPineapples, liveDetections)
       + scans doc (counts, scanProgress, processedFrames, totalFrames)
          |
          v  stop (POST /api/drone/stop-detection → stop_detection())
stop_detection() checks get_scan_status() FIRST and never overwrites a
       terminal status ('completed'/'failed'/'cancelled'); then
       _compute_population_estimates() → complete_scan_session() →
       check_thresholds_and_create_alerts()
```

Video variant: `POST /api/drone/upload-video` (MP4 only) saves to `_UPLOADS_DIR`
(`%TEMP%/pinevision_uploads`), then `start_video_scan()` →
`_video_scan_loop_sequential()`: sequential `cap.read()` every Nth frame (default
5) → `save_detection_manifest()` writes `<scan_id>_manifest.json` BEFORE
`complete_scan_session()` sets `manifestReady=True`; the frontend fetches
`GET /api/drone/scan/<scan_id>/manifest` (scan_id validated in routes.py).

Scan status transitions: `active` → `completed` (complete_scan_session) or
`failed` (stream start failure, loop error/cancel, interrupted video, or
manifest write failure — each path writes `status:'failed'` + `endTime`).

## Where each stage lives

| Stage | Owner |
|---|---|
| HTTP endpoints `/api/drone/*` | `routes.py` (`drone_bp`) |
| RTMP validation, stream health | `service.py` (`connect`, `status`) |
| MediaMTX control API (:9997) | `mediamtx.py` (`list_paths`, `get_path`) |
| MediaMTX process lifecycle | `process_manager.py` (`ensure_running`, `stop`) |
| Frame capture / reconnect | `stream_capture.py` (`HLSStreamCapture`) |
| YOLO + DeepSORT, scan loops, thresholds | `detection.py` (`PineappleDetector`) |
| **All Firestore writes** | `firebase_client.py` |

Dead code — editing has no effect: `_video_scan_loop()` (docstring: "NOT CURRENTLY
USED"; `start_video_scan()` always spawns `_video_scan_loop_sequential()`), and
`push_video_time()` (no-op stub; `/api/drone/video-time` exists but is ignored).

## Model loading (verified in `PineappleDetector.__init__`)

- **Primary path: `ultralytics.YOLO(model_path)`** with
  `self.use_ultralytics = True`. Device is `'cuda'` if available else `'cpu'`.
- **`torch.hub.load('ultralytics/yolov5', 'custom', ...)` is only the
  fallback** when the ultralytics import/load raises. Output parsing in
  `detect_frame()` branches on `use_ultralytics`.
- The active path is visible at startup: the log prints "using Ultralytics" or
  "using torch.hub". Weights come from `backend/best.pt` via `get_detector()`
  (default `Path(__file__).parent.parent / 'best.pt'`). Don't assert a YOLO
  version (the repo's own comments disagree); describe the load path instead.

## Firestore write ownership (`firebase_client.py`)

All `scans` / `blocks` / `monitoring_alerts` writes route through here —
do not add `db.collection(...)` calls elsewhere. Key helpers:
`get_firestore_client()` (reuses the app `app.py` initialized; standalone
fallback initializes from `backend/serviceAccountKey.json`),
`create_scan_session()`, `update_detection_batch()` (one batch: block stats
+ scan progress), `save_detection_manifest()`, `complete_scan_session()`
(one batch: final scan doc + block `totalScans` Increment), `get_scan_status()`,
`get_block_population()`. Alerts are the location exception: `check_thresholds_and_create_alerts()` lives in
`detection.py`, runs a single `blockId`+`resolved==False` query on `monitoring_alerts`
(requires the composite index blockId ASC / resolved ASC) and commits creates +
auto-resolves in one batch. Thresholds: bearing watch 75% / critical 60%,
non-bearing 18% / 25%, non-viable 10% / 15%.

## Testing without a drone

No automated tests exist — verification is manual.

```bash
cd backend
./venv/Scripts/python.exe -m drone_conn.detection --video <clip.mp4> \
    --block_id test_block --user_id test_user [--frame_skip 2]
```

This is `run_video_scan()`: needs the venv, `backend/best.pt`, and a real
`backend/serviceAccountKey.json` (standalone Firebase init — **it writes to
live Firestore**, creating real scan/block documents). Watch the per-frame
logs and final counts. Other checks: `python -m drone_conn.stream_capture`
(10s MediaMTX capture smoke test), `python test_imports.py` after dependency
changes, boot `app.py` and expect `✅ Firebase connected successfully!`. Windows
consoles that choke on emoji output (`UnicodeEncodeError ... charmap`): set `PYTHONUTF8=1`.
For a fake publisher:
`ffmpeg -re -f lavfi -i testsrc=size=640x480:rate=25 -f lavfi -i sine -c:v libx264 -preset ultrafast -c:a aac -f flv rtmp://localhost:1935/pinevision_scan`

## Hard rules

- Never print, echo, or copy `backend/serviceAccountKey.json` contents.
- Never read `backend/best.pt` or `output/*.ts` into context (large binaries).
- Never create fake credentials or placeholder weights.
- No automated test suite exists — never claim "tests pass"; describe the
  manual verification you actually ran.

## What this skill can't tell you

Model retraining / replacing `best.pt`, drone-side setup in DJI Fly beyond
the RTMP URL, MediaMTX tuning beyond `mediamtx/mediamtx.yml` ports, and any
deployment/hosting process — none are documented in the repo.
