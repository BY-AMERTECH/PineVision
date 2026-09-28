# PineVision — Knowledge Reference

A concise, verified reference to how PineVision actually works, built by
reading the repository on 2026-09-28. For file-by-file structure and dev
commands see [`AGENTS.md`](./AGENTS.md).

## What the application does

PineVision is a smart farm monitoring platform for pineapple plantations. A
DJI drone flies over a "block" (a section of the plantation) streaming RTMP
video; the system converts that to a browser-playable stream, runs an
object-detection model over it in real time, classifies every pineapple
plant it sees into **bearing / non-bearing / non-viable**, tracks unique
plants across frames so the same plant isn't double-counted, and streams the
running totals to the frontend and into Firestore. When a scan ends, final
stats are saved and threshold-based alerts are created or auto-resolved.

Three user roles exist in the live code (confirmed in `backend/app.py` and
`frontend/js/auth.js`): **admin** ("Super Admin"), **farm_manager**, and
**client**, each with its own page tree
(`frontend/pages/{admin,client,farm-manager}/`) and, for admin/farm_manager,
server-side token+role verification in `app.py`
(`_verify_admin_token`, `_verify_farm_manager_token`). Farm Managers get a
subset of admin-style user-management endpoints (`/api/fm/users*`) but are
explicitly blocked from ever creating, editing, or reading Super Admin
accounts.

> **Note on stale docs:** `project-documentation/system-summary.md` and
> `features-summary.md` describe only two roles (Admin, Client) and predate
> the `farm_manager` role and its page tree — treat those two files as
> historical background, not current truth, for anything role-related.

## Main components and data flow

```
DJI Drone (RTMP) ──▶ MediaMTX (mediamtx/mediamtx.exe)
                         │  converts RTMP → HLS + RTSP
                         │  auto-started by backend/drone_conn/process_manager.py
                         ▼
        backend/drone_conn/stream_capture.py
        (opens the stream with OpenCV; prefers RTSP over HLS
         when talking to MediaMTX — avoids HLS segment-boundary gaps)
                         │  frames, sampled at N FPS
                         ▼
        backend/drone_conn/detection.py
        - loads YOLO weights from backend/best.pt via ultralytics.YOLO
          (falls back to torch.hub('ultralytics/yolov5', 'custom', ...) if
          ultralytics import/load fails — so the model is effectively
          YOLOv8-trained-and-loaded-via-ultralytics with a YOLOv5-repo
          fallback path; the two docs in this repo disagree on which
          version is authoritative, see "Open questions" below)
        - DeepSORT (deep-sort-realtime) assigns a persistent ID per
          detected plant so it's counted once even across many frames
                         │  running per-class unique counts
                         ▼
        backend/drone_conn/firebase_client.py
        - batches writes to Firestore: block stats + scan progress every
          ~2 seconds while a scan is active; final write + threshold/alert
          check (`check_thresholds_and_create_alerts`) on scan completion
                         ▼
        Firestore ("blocks", "scans", "monitoring_alerts", "users",
                    "activity_logs", "alerts", "scheduled_scans", "missions")
                         │  Firebase real-time listeners
                         ▼
        frontend/js/drone-view.js (+ dashboard.js, scans.js, alerts.js, ...)
        - renders live stats, drives the Connect Drone / Upload MP4 /
          End Scan UI on frontend/pages/*/drone-view.html
```

Entry point for all of this on the server side is `backend/app.py`, a single
Flask app that:
- initializes Firebase Admin from `backend/serviceAccountKey.json`,
- registers the `drone_bp` blueprint (`backend/drone_conn/routes.py`,
  everything under `/api/drone/*`),
- exposes direct `/api/users/*` (admin) and `/api/fm/users/*`
  (farm_manager) REST endpoints for account management, and
- serves every frontend file itself (`/`, `/client/<page>`,
  `/admin/<page>`, `/farm-manager/<page>`, and a catch-all for other static
  assets) — there is no separate static file server or CDN.

### Detection entry points (from `routes.py` / `SETUP_INSTRUCTIONS.md`)

| Endpoint | Purpose |
|---|---|
| `GET /api/test` | Health check, reports Firebase connection status |
| `POST /api/drone/prepare` | Auto-starts MediaMTX, detects local IPv4, returns a prefilled RTMP URL |
| `POST /api/drone/connect` | Validates an RTMP URL, returns the HLS URL to play |
| `GET /api/drone/status?path=NAME` | Checks stream health via MediaMTX's control API |
| `POST /api/drone/start-detection` | Starts the YOLO+DeepSORT loop against a live HLS/RTSP stream |
| `POST /api/drone/stop-detection` | Stops detection, finalizes the scan |
| `POST /api/drone/upload-video` | Accepts an uploaded MP4, runs an async background scan, streams results to Firestore every 2s |

Detection can also be run standalone from the CLI without the web UI:
`python -m drone_conn.detection --video <path> --block_id <id> --user_id <id> [--frame_skip N]`
(see `SETUP_INSTRUCTIONS.md`, "Testing Without Drone → Option B").

## Important dependencies

From `backend/requirements.txt`:
- **Flask** 2.3.0 + **flask-cors** 4.0.0 — web server / API
- **firebase-admin** ≥6.2.0 — Firestore + Firebase Auth from the backend
- **torch** / **torchvision** ≥2.0 (CPU build per setup docs) + **ultralytics** ≥8.0.0 — YOLO inference
- **opencv-python** ≥4.8.0 — video frame decode
- **deep-sort-realtime** ≥1.3.2 — multi-object tracking
- **av**, **ffmpeg-python** — video/stream handling (FFmpeg must also be
  separately installed and on PATH; the repo does not vendor it)
- **python-dotenv**, **requests**, **pillow** — utility/support
- Note: `setuptools>=70,<80` is deliberately pinned — a comment in
  `requirements.txt` says `deep-sort-realtime` needs `pkg_resources`, which
  setuptools ≥80 removed.

Frontend has no package manager dependency — Bootstrap 5 is vendored
directly under `frontend/bootstrap/`.

`scripts/migrate-user-ids.js` is a separate Node.js tool (own
`node_modules/`, uses `firebase-admin` for Node) for a one-time Firestore
data migration (backfilling `userId` on `blocks`/`monitoring_alerts` docs).
It is not part of the running application.

## Configuration / environment

There is no `.env.example` or documented environment-variable list in the
repo as inspected — configuration is mostly via files, not env vars:

- `backend/serviceAccountKey.json` — Firebase Admin service account (required,
  gitignored, must be obtained from the Firebase console for project
  `pinevision-632aa` per `SETUP_INSTRUCTIONS.md`)
- `backend/best.pt` — YOLO model weights (required, gitignored, ~22MB;
  classes `bearing` / `non-bearing` / `non-viable`)
- `mediamtx/mediamtx.yml` — MediaMTX server configuration (RTMP/HLS/RTSP
  ports etc.)
- `firestore.rules` (repo root) — Firestore security rules; currently quite
  permissive (any authenticated user can read/write most collections, and a
  few collections like `users` and `activity_logs` allow unauthenticated
  `create` for login/lookup flows)
- Flask itself runs with `debug=True` on `0.0.0.0:5000` (hardcoded in
  `app.py`'s `__main__` block, not env-driven)
- `python-dotenv` is a dependency but no `.env` file or `load_dotenv()` call
  was found in the files inspected — if one exists it wasn't located, flag
  this if you need to confirm before relying on it

## Known limitations / open questions (from repo inspection, not invented)

- **YOLO version is ambiguous in the repo's own comments.** `detection.py`'s
  docstring says "Uses YOLOv5 for detection", a later comment says "YOLOv8
  is trained at 640×640", and the primary load path is
  `ultralytics.YOLO(model_path)` with a fallback to
  `torch.hub.load('ultralytics/yolov5', ...)`. Don't assert a specific YOLO
  version without checking which load path is actually active for the
  current `best.pt`.
- **`FIXES_NEEDED.md` appears stale.** All 7 numbered fixes it lists were
  checked against the current source during this inspection and each
  appears already present (e.g. `scans.js` already redirects to
  `/index.html`, `app.js` already reads `link.getAttribute('href')` at
  click time, `firebase_client.py`'s `complete_scan_session()` already
  writes final `bearingPercent`/`nonBearingPercent`/`nonViable` to the
  block). Treat this file as a historical changelog, not a current TODO
  list, unless you re-verify a specific item against the current file.
- **`project-documentation/*-summary.md` predate the Farm Manager role.**
  They describe a two-role system (Admin/Client); the code has three
  (`admin`/`farm_manager`/`client`) with a dedicated `farm-manager` page
  tree and `/api/fm/*` endpoints. Cross-check anything role-related against
  `app.py` / `auth.js` rather than these summaries.
- **No automated test suite.** `test_imports.py` only checks that key
  packages import; `test_video_firebase.py` is a manual script that runs
  detection against a real video file and writes to live Firestore. Neither
  is wired into CI (none exists) or a test runner like pytest.
- **PDF report export status is unclear.** `features-summary.md` flags it as
  "may be partially implemented" — this was not independently verified
  against `reports.html`/`reports.js` logic during this pass; confirm before
  claiming PDF export works or doesn't.
- **No `.env` / environment-variable documentation found**, despite
  `python-dotenv` being a listed dependency — confirm whether any code path
  actually loads a `.env` file before assuming one is required or unused.
- **`output/` at the repo root contains large `.ts`/`.m3u8` files** (HLS
  segments from a prior test run, tens of MB) that are not `.gitignore`d
  individually by name (only the `output` folder created by the HLS test
  steps in `SETUP_INSTRUCTIONS.md`) — worth confirming these aren't
  accidentally tracked in git before committing.
- **`project-documentation/best.pt`** — there is a second copy of the YOLO
  weights file inside `project-documentation/`. Unclear whether this is
  intentional (e.g. a reference copy for that folder's own analysis
  scripts) or a stray duplicate; not investigated further here.

## Repository paths worth knowing

- Flask entry / routing: `backend/app.py`
- Detection engine: `backend/drone_conn/detection.py`
- Firestore writes: `backend/drone_conn/firebase_client.py`
- Stream capture: `backend/drone_conn/stream_capture.py`
- Drone API routes: `backend/drone_conn/routes.py`
- MediaMTX lifecycle: `backend/drone_conn/process_manager.py`,
  `backend/drone_conn/mediamtx.py`
- Live detection UI: `frontend/js/drone-view.js`,
  `frontend/pages/{admin,client,farm-manager}/drone-view.html` (or
  equivalent — confirm exact filename per role tree before editing)
- Auth + role routing: `frontend/js/auth.js`
- SPA page transitions: `frontend/js/app.js`
- Security rules: `firestore.rules`
- Setup/run instructions: `SETUP_INSTRUCTIONS.md`
- Architecture notes (partly superseded by this file): `INTEGRATION_GUIDE.md`
