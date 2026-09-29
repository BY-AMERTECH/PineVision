# AGENTS.md — PineVision

Instructions for any coding agent (Claude, Codex, Copilot, etc.) making changes
to the PineVision repository. This file is derived from inspecting the actual
repo on 2026-09-28 — see [`knowledge.md`](./knowledge.md) for the fuller
architecture/data-flow reference this was built from.

## What this project is

PineVision is a drone-based pineapple plantation monitoring system: a DJI
drone streams RTMP video, a Python/Flask backend converts it to HLS/RTSP
(via MediaMTX) and runs a YOLO + DeepSORT detection pipeline on it, and a
vanilla HTML/CSS/JS frontend (served by the same Flask app) shows live counts
and lets Admin / Farm Manager / Client users manage blocks, scans, alerts,
users, and reports through Firebase (Auth + Firestore).

## Verified repository structure

```
PineVision/
├── backend/
│   ├── app.py                    # Flask entry point: serves frontend + registers /api/drone/* + user-mgmt API
│   ├── requirements.txt
│   ├── best.pt                    # YOLO weights (gitignored, ~22MB)
│   ├── serviceAccountKey.json     # Firebase Admin credentials (gitignored, required to run)
│   ├── test_imports.py            # Manual dependency-import smoke check (not pytest)
│   ├── test_video_firebase.py     # Manual script: run detection on a video file + write to live Firestore
│   ├── venv/                      # Local virtualenv (gitignored)
│   └── drone_conn/                # Core backend package
│       ├── routes.py              # Blueprint: /api/drone/* (prepare, connect, status, start/stop-detection, upload-video)
│       ├── detection.py           # YOLO (ultralytics, torch.hub fallback) + DeepSORT tracking, scan lifecycle (largest file, ~62KB)
│       ├── firebase_client.py     # Firestore batched writes: scans, blocks, monitoring_alerts
│       ├── stream_capture.py      # Frame capture; prefers RTSP over HLS for MediaMTX streams
│       ├── process_manager.py     # Auto-start/stop MediaMTX process
│       ├── mediamtx.py            # MediaMTX control-API client (stream path queries)
│       ├── network.py             # Local IPv4 detection (for RTMP URL prefill)
│       └── service.py             # Stream connection service
├── frontend/                      # No build step — plain static files served by Flask
│   ├── pages/
│   │   ├── index.html             # Login page, served at "/"
│   │   ├── admin/                 # 8 pages (Super Admin role)
│   │   ├── client/                # 10 pages (Client role)
│   │   └── farm-manager/          # 9 pages (Farm Manager role)
│   ├── js/                        # app.js (SPA nav), auth.js (Firebase auth + role routing),
│   │                               # drone-view.js (live detection UI, largest, ~54KB), dashboard.js,
│   │                               # flight.js, scans.js, alerts.js, data.js, cache.js, utils.js
│   ├── css/                       # tokens.css, layout.css, components.css, auth.css, drone-view.css, responsive.css
│   ├── bootstrap/                 # Vendored Bootstrap 5 (css/js)
│   └── assets/                    # icons/, images/
├── mediamtx/                      # mediamtx.exe + mediamtx.yml — RTMP→HLS/RTSP server, auto-launched by process_manager.py
├── scripts/
│   └── migrate-user-ids.js        # One-off Node script (own node_modules/, uses firebase-admin) — NOT part of the running app
├── project-documentation/         # Prior human/AI analysis notes — background reading, not source of truth (see knowledge.md)
├── firestore.rules
├── README.md, SETUP_INSTRUCTIONS.md, INTEGRATION_GUIDE.md, DETECTION_TESTING_PLAN.md, FIXES_NEEDED.md
└── .gitignore
```

There is **no `package.json`** anywhere in the repo — the frontend is
unbundled static HTML/CSS/JS, not a Node project. `scripts/` is a standalone
Node.js utility with its own `node_modules/`; it is unrelated to how the app
runs.

There is **no CI configuration** (no `.github/workflows/`) and **no
automated test suite** (no pytest/unittest files) as of this inspection.
`test_imports.py` and `test_video_firebase.py` are manual, human-run scripts,
not something a CI pipeline invokes.

Git remote: `https://github.com/merantoneth-tech/PineVision.git`, default
branch `main`.

## Development commands (from SETUP_INSTRUCTIONS.md, verified against app.py)

```bash
# Backend
cd backend
python -m venv venv
.\venv\Scripts\activate          # Windows; source venv/bin/activate on Mac/Linux
pip install -r requirements.txt
python test_imports.py           # sanity-check torch/cv2/firebase_admin/deep_sort_realtime import
python app.py                    # runs Flask on http://0.0.0.0:5000, debug=True
```

The frontend has no separate dev server — Flask serves it directly.
Requests to `/`, `/client/<page>`, `/admin/<page>`, `/farm-manager/<page>`,
and any other static path are all routed by `app.py` to files under
`frontend/`. **Do not open frontend HTML files via `file://`** — routes,
Firebase config, and API calls assume they're served from Flask.

Required local files that are **not** in git and must exist for the backend
to start correctly (see `.gitignore` and `SETUP_INSTRUCTIONS.md`):
- `backend/serviceAccountKey.json` — Firebase Admin credentials
- `backend/best.pt` — YOLO model weights
- `mediamtx/mediamtx.exe` — auto-launched by `process_manager.py` when the
  frontend calls `POST /api/drone/prepare`

## Coding conventions observed in this repo

- **Backend (Python/Flask):** endpoints grouped by Blueprint
  (`drone_bp` in `routes.py`, url_prefix `/api/drone`); plain Flask routes
  for user-management/frontend-serving live directly in `app.py`. Role
  checks are done per-request via small `_verify_admin_token()` /
  `_verify_farm_manager_token()` helpers that decode a Firebase ID token
  from the `Authorization: Bearer <token>` header and look up the user's
  `role` field in Firestore — follow this pattern for any new protected
  endpoint rather than inventing a new auth scheme.
- Firestore writes go through `drone_conn/firebase_client.py`, which
  batches related writes (e.g. `complete_scan_session()` updates both the
  `scans` doc and the `blocks` doc's aggregate stats in one batch). Keep
  new scan/block-mutating logic there rather than writing ad hoc
  `db.collection(...).set(...)` calls scattered across other modules.
- Print-based logging with emoji prefixes (`✅`, `❌`, `🚀`, `📊`, etc.) is
  the established style in `app.py` and `drone_conn/*.py` for
  human-readable console output — match it for consistency rather than
  introducing a different logging style, unless asked to formalize logging.
- **Frontend (vanilla JS, no framework/bundler):** one `.js` file per page
  concern (`drone-view.js`, `scans.js`, `alerts.js`, ...) plus shared
  `utils.js`, `data.js`, `cache.js`, `auth.js`. `app.js` handles SPA-style
  page transitions and calls a page's global `window.initPage()` on
  `DOMContentLoaded` — a page script should define `initPage` once and
  **not** also register its own separate `DOMContentLoaded` listener (this
  exact double-registration bug is documented as fixed in
  `FIXES_NEEDED.md`; verify that pattern isn't reintroduced).
- CSS is split by concern under `frontend/css/` (`tokens.css` for
  variables, `layout.css`, `components.css`, per-page files like
  `drone-view.css`) with Bootstrap 5 vendored in `frontend/bootstrap/` for
  base grid/components.
- Role-gated pages exist as three parallel page trees
  (`pages/admin/`, `pages/client/`, `pages/farm-manager/`) rather than one
  tree with client-side role branching — when adding a role-specific page,
  follow this existing convention (new file under the matching role
  directory + a matching Flask route already exists generically via
  `serve_admin_page`/`serve_client_page`/`serve_farm_manager_page` in
  `app.py`).

## Making and checking changes

There is no linter, formatter, or automated test runner configured in this
repo (confirmed: no `.flake8`/`pyproject.toml`/`.eslintrc`/CI files found).
Because of that, agents must verify changes manually and explicitly:

1. **Read before you write.** Grep/read the actual file(s) you're changing
   and any file that calls into it — several past bugs here were caused by
   files getting out of sync (see `FIXES_NEEDED.md`; most listed fixes
   appear already applied in the current code as of this inspection —
   confirm current behavior in the file itself rather than trusting that
   document).
2. **Backend changes:** at minimum, run `python test_imports.py` after
   touching dependencies, and manually start `python app.py` to confirm it
   boots without exceptions and prints `✅ Firebase connected successfully!`
   (requires a valid `serviceAccountKey.json`). For detection-pipeline
   changes, `SETUP_INSTRUCTIONS.md` documents three ways to exercise the
   pipeline without a physical drone — the MP4 CLI mode
   (`python -m drone_conn.detection --video ... --block_id ... --user_id ...`)
   is the fastest to verify locally and needs no MediaMTX.
3. **Frontend changes:** there's no bundler/build step, so verify by
   actually loading the affected page through the running Flask server
   (`http://localhost:5000/...`), not by opening the HTML file directly.
   Check the browser console for errors after any JS change.
4. **Firestore rule / schema changes:** `firestore.rules` at the repo root
   is quite permissive (any authenticated user can read/write most
   collections) — if asked to tighten it, check `INTEGRATION_GUIDE.md`'s
   collection structure section and `firebase_client.py` for what fields
   each collection actually needs, so rules don't break a legitimate write
   path.
5. Never commit `backend/serviceAccountKey.json`, `backend/best.pt`,
   `backend/venv/`, or anything else already listed in `.gitignore`.

## Where to go for more detail

- [`knowledge.md`](./knowledge.md) — architecture, data flow, dependencies,
  config/env, and known gaps.
- [`CLAUDE.md`](./CLAUDE.md) — Claude-specific workflow notes for this
  folder.
- [`SKILL.md`](../.agents/skills/pinevision-common-tasks/SKILL.md) — step-by-step workflows for common PineVision
  tasks (add a feature, fix a bug, change the UI).
