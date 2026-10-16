# PineVision — Knowledge Reference

Verified reference facts about how PineVision works. Rules and conventions are
in [`../AGENTS.md`](../AGENTS.md); this file holds facts. Last checked against
source on 2026-09-29. Items marked **(unverified)** were not checked against code.

## What it does

A DJI drone streams RTMP video over a plantation "block". MediaMTX converts it
to HLS/RTSP, the Flask backend runs YOLO + DeepSORT on the frames, classifies
each plant as **bearing / non-bearing / non-viable**, counts each tracked plant
once, and writes running totals to Firestore. When a scan ends, final stats are
saved and threshold alerts are created or auto-resolved. An MP4 can be scanned
instead of a live stream.

Three roles exist in code (`admin` = Super Admin, `farm_manager`, `client`),
each with a page tree under `frontend/pages/`. `app.py` verifies token + role
server-side for admin (`/api/users*`) and farm manager (`/api/fm/users*`). Farm
managers can't create, edit, or read Super Admin accounts.

## Where things live

| Area | Location |
|---|---|
| Flask entry, user-management API, serves the frontend | `backend/app.py` |
| `/api/drone/*` endpoints (`drone_bp`) | `backend/drone_conn/routes.py` |
| YOLO + DeepSORT, scan loops, alert thresholds | `backend/drone_conn/detection.py` (`PineappleDetector`) |
| Firestore scan/block writes | `backend/drone_conn/firebase_client.py` |
| Frame capture / reconnect | `backend/drone_conn/stream_capture.py` |
| RTMP validation, stream health | `backend/drone_conn/service.py` |
| MediaMTX API client / process | `backend/drone_conn/mediamtx.py`, `process_manager.py` |
| Live detection UI | `frontend/js/drone-view.js` + `frontend/pages/*/drone-view.html` |
| Auth + role routing / SPA nav | `frontend/js/auth.js` / `frontend/js/app.js` |
| Security rules | `firestore.rules` |
| Setup / run steps | `SETUP_INSTRUCTIONS.md` |

## Detection pipeline

```
Drone --RTMP :1935--> MediaMTX (HLS :8888, RTSP :8554, control API :9997)
   process_manager.ensure_running() launches mediamtx.exe with mediamtx/mediamtx.yml
POST /api/drone/prepare -> /connect (service.connect validates the RTMP URL,
   checks the path via mediamtx.get_path(), returns the HLS URL)
POST /api/drone/start-detection -> get_detector().start_detection()
   singleton, _scan_lock-guarded; a second scan raises ScanInProgressError -> 409
HLSStreamCapture: prefers RTSP-over-TCP derived from the HLS URL, falls back to HLS;
   frames go to Queue(maxsize=10) at `fps` (route default 1); reconnects after
   30 consecutive read failures, at most 5 reconnects
PineappleDetector.detect_frame(): resize to 640 -> YOLO -> DeepSort
   (max_age=30, n_init=3, max_iou_distance=0.7) -> count only is_confirmed() tracks;
   track_categories locks a track's class at first confirmation;
   unique_ids = per-class sets (bearing / non_bearing / non_viable)
every update_interval (2.0 s), daemon thread: update_detection_batch()
   ONE batch = blocks doc (percents, totals) + scans doc (counts, progress)
POST /api/drone/stop-detection -> stop_detection(): get_scan_status() first;
   never overwrites completed/failed/cancelled; then _compute_population_estimates()
   -> complete_scan_session() (one batch: scan doc final + block stats + totalScans
   Increment) -> check_thresholds_and_create_alerts()
```

**Video variant.** `POST /api/drone/upload-video` accepts `.mp4` only, stores it in
`%TEMP%/pinevision_uploads` (`_UPLOADS_DIR`), then `start_video_scan()` runs
`_video_scan_loop_sequential()` (every Nth frame, route default N=5). The manifest
`<scan_id>_manifest.json` is written *before* `manifestReady=True`; the frontend
reads `GET /api/drone/scan/<scan_id>/manifest` (scan_id validated in `routes.py`).

**Scan status.** `create_scan_session()` writes `active`. `complete_scan_session()`
writes `completed`. `failed` (+ `endTime`) is written by stream-start failure,
loop error/cancel, interrupted video, and manifest-write failure. `cancelled` is
checked in `stop_detection()` but nothing in the inspected code writes it.

**Alerts.** `check_thresholds_and_create_alerts()` (in `detection.py`) does one
`monitoring_alerts` query (`blockId` + `resolved == False`; needs a composite
index blockId ASC / resolved ASC) and commits creates and auto-resolves in one
batch. Thresholds (watch / critical): bearing 75 / 60 %, non-bearing 18 / 25 %,
non-viable 10 / 15 %.

**Dead code (edits have no effect):** `_video_scan_loop()` ("NOT CURRENTLY USED";
`start_video_scan()` always spawns the sequential loop) and `push_video_time()`
(no-op; `/api/drone/video-time` exists but is ignored).

**Model loading.** Primary path is `ultralytics.YOLO(model_path)`
(`use_ultralytics=True`, device `cuda` if available else `cpu`); `torch.hub`
`ultralytics/yolov5` is only the fallback when the ultralytics load raises.
`detect_frame()` branches on `use_ultralytics`. The docstring says "YOLOv5" and a
comment says "YOLOv8"; describe the load path instead of asserting a version.
Weights: `backend/best.pt` (classes `bearing`, `non-bearing`, `non-viable`).

### API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/test` | Health check, Firebase status |
| `POST /api/drone/prepare` | Starts MediaMTX, returns prefilled RTMP URL |
| `POST /api/drone/connect` | Validates RTMP URL, returns HLS URL |
| `GET /api/drone/status?path=NAME` | Stream health via MediaMTX API |
| `POST /api/drone/start-detection` / `stop-detection` | Start/finish a live scan |
| `POST /api/drone/upload-video` | MP4 background scan |
| `GET /api/drone/scan/<id>/manifest` | Per-frame detections for an uploaded-video scan |

### Testing without a drone

No automated tests exist. Options (the first two **write to live Firestore**):

```bash
cd backend
./venv/Scripts/python.exe -m drone_conn.detection --video clip.mp4 --block_id test_block --user_id test_user [--frame_skip 2]
python -m drone_conn.stream_capture      # 10 s MediaMTX capture smoke test
```

Standalone mode initializes Firebase from `backend/serviceAccountKey.json`. On
Windows consoles that fail on emoji (`UnicodeEncodeError ... charmap`), set
`PYTHONUTF8=1`. Fake publisher:
`ffmpeg -re -f lavfi -i testsrc=size=640x480:rate=25 -f lavfi -i sine -c:v libx264 -preset ultrafast -c:a aac -f flv rtmp://localhost:1935/pinevision_scan`

## Dependencies and configuration

- `backend/requirements.txt`: Flask, flask-cors, firebase-admin, torch/torchvision,
  ultralytics, opencv-python, deep-sort-realtime, av, ffmpeg-python, requests,
  python-dotenv, pillow. `setuptools>=70,<80` is pinned because
  `deep-sort-realtime` needs `pkg_resources`. FFmpeg must be installed separately.
- Frontend has no package manager; Bootstrap 5 is vendored. `scripts/` is a
  standalone Node utility (`migrate-user-ids.js`, backfills `userId`); not part
  of the app.
- Config is file-based. `python-dotenv` is listed but no `load_dotenv` call exists
  in `backend/*.py` or `backend/drone_conn/*.py`, so no `.env` is needed.
  Firebase project: `pinevision-632aa` (per `SETUP_INSTRUCTIONS.md`).
- Flask runs `debug=True` on `0.0.0.0:5000`, hardcoded.
- `firestore.rules`: any authenticated user can read/write `blocks`, `scans`,
  `monitoring_alerts`, `missions`, and `users` (except `users` read is public, for
  username lookup); `activity_logs` and `alerts` allow unauthenticated `create`;

Scheduled Scan scheduling and its application reads/writes have been removed; existing Firestore records are retained and were not deleted.

## Known gaps and stale docs

- **`FIXES_NEEDED.md` appears stale** (a 2026-09-28 pass found its items already
  applied; not re-checked in full on 2026-09-29). Treat it as history.
- **`project-documentation/*-summary.md` describe two roles** and predate
  `farm_manager`.
- `routes.py`'s `upload_video` docstring says `frame_skip` default 2; the code
  default is 5.
- **No automated tests, linter, or CI.**
- **`.gitignore` problems:** `*.json` ignores every JSON file, and the last lines
  are fused (`*.swo/project-documentation/`), so `project-documentation/` is not
  actually ignored. Its 9 `.md` files are tracked; `best.pt` copies are not.
- `output/` has four tracked files (`index.m3u8`, `index0-2.ts`, HLS test output).
- **PDF report export status is unverified.**
