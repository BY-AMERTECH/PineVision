---
name: pinevision-common-tasks
description: Use when adding or changing a feature, fixing a bug, or updating the UI in the PineVision drone/pineapple-monitoring repo. Derived from the actual codebase structure, not a generic template.
---

# PineVision — Common Task Workflows

Background: [`knowledge.md`](../../../llm-context/knowledge.md). Structure/commands/conventions:
[`AGENTS.md`](../../../llm-context/AGENTS.md). When to use this file vs. those:
[`CLAUDE.md`](../../../llm-context/CLAUDE.md).

## When to use this skill

Reach for the matching workflow below whenever the task is one of: adding a
backend endpoint or detection behavior, fixing a reported bug in the
detection/scan pipeline or a page, or changing something in the frontend UI.
For anything else (infra, deployment, model retraining), there's no
established workflow in this repo to follow — inspect first and say so if
nothing applies.

---

## Workflow A — Add or change a backend feature (API endpoint, detection logic, Firestore write)

1. **Locate the right layer** before writing anything:
   - New/changed HTTP endpoint under `/api/drone/*` → `backend/drone_conn/routes.py`
   - New/changed endpoint for user management → `backend/app.py` (existing
     `/api/users/*` for admin, `/api/fm/users/*` for farm_manager — mirror
     the existing `_verify_admin_token()` / `_verify_farm_manager_token()`
     pattern for auth, don't invent a new one)
   - Detection behavior (classes, confidence, tracking) →
     `backend/drone_conn/detection.py`
   - Anything that reads/writes Firestore (`blocks`, `scans`,
     `monitoring_alerts`) → route the write through
     `backend/drone_conn/firebase_client.py` rather than adding a new
     `db.collection(...)` call elsewhere, so batching/lifecycle stays in
     one place
   - Stream connection/health → `backend/drone_conn/service.py`,
     `stream_capture.py`, `mediamtx.py`, `process_manager.py`
2. **Read the whole function/file you're changing**, plus its callers (grep
   for the function name across `backend/`) — several existing bugs in this
   repo came from one file being updated without its caller.
3. Match existing conventions (see `AGENTS.md`): Blueprint routing, emoji
   print-logging, batched Firestore writes, `_verify_*_token()` gates for
   protected endpoints.
4. If the change affects what's stored per block/scan, check
   `firestore.rules` — a new field usually doesn't need a rule change since
   most collections here allow broad authenticated read/write, but a new
   *collection* does need a `match` block added.
5. **Verify:**
   - `cd backend && python test_imports.py` if you touched dependencies.
   - `python app.py` and confirm it boots (`✅ Firebase connected
     successfully!`, no traceback) — requires a real
     `serviceAccountKey.json` locally.
   - For detection-pipeline changes, run the MP4 CLI path against a sample
     video (no MediaMTX/drone needed):
     `python -m drone_conn.detection --video <path.mp4> --block_id test_block --user_id test_user`
     and check the printed per-frame/final counts look sane.
   - Hit the changed endpoint manually (`curl`/`Invoke-RestMethod`, or
     through the UI) and check the Firestore document it's supposed to
     write, per the collection layout in `knowledge.md`.
   - There is no automated test suite to run instead of the above — say so
     rather than claiming "tests pass."

## Workflow B — Fix a reported bug

1. **Find the file(s) named in the report.** If it references
   `FIXES_NEEDED.md`, don't assume the listed fix is still needed — as of
   this inspection, every item in that file already appeared present in the
   current source (see `knowledge.md`). Re-check the actual current file
   and line before writing a fix; the bug may already be fixed, or may have
   moved/changed shape.
2. Reproduce first where practical:
   - Backend/detection bug → run the MP4 CLI mode (Workflow A, step 5) or
     `test_video_firebase.py` (needs a real video + live Firestore) to see
     the failure directly.
   - Frontend bug → load the actual page through
     `http://localhost:5000/<role>/<page>.html` (Flask must be running) and
     reproduce via the browser console, not by reading the HTML/JS alone.
3. Watch for this repo's known recurring bug shape: a page module defining
   `window.initPage` **and** also calling
   `document.addEventListener('DOMContentLoaded', initPage)` itself — that
   double-registers every handler on the page. `app.js` already invokes
   `window.initPage()` on load; a page script should only define the
   function.
4. Fix at the narrowest point that matches the existing pattern in that
   file (e.g. a stale `href` should be read live via `getAttribute('href')`
   at click time, per the pattern already used in `app.js`, not cached in a
   closure).
5. **Verify:** re-run the same reproduction from step 2 and confirm the
   specific symptom is gone. Skim the surrounding function once more for a
   second copy of the same mistake (several past fixes here were needed in
   more than one file — check `FIXES_NEEDED.md`'s own "File Index" table for
   the shape of that).

## Workflow C — Update the UI (a page, a component, styling)

1. **Identify every role tree the page exists in.** Client-facing pages
   often have near-duplicate copies across `frontend/pages/client/` and
   `frontend/pages/admin/` (e.g. `dashboard.html`, `alerts.html`,
   `reports.html`, `settings.html` exist in both, sized almost identically
   — check both before assuming a change to one covers the feature).
   `frontend/pages/farm-manager/` overlaps heavily with `admin/` in file
   names too. If the task is about one role only, edit only that role's
   copy; if it's a shared visual/behavioral bug, check whether it needs
   fixing in more than one tree.
2. **Locate shared vs. page-specific code:**
   - Shared: `frontend/js/app.js` (navigation), `auth.js` (auth/role
     guard), `utils.js`, `data.js`, `cache.js`; `frontend/css/tokens.css`
     (design tokens), `layout.css`, `components.css`.
   - Page-specific: matching `.js`/`.css` by name (`drone-view.js` +
     `drone-view.css`, `dashboard.js`, `flight.js`, `scans.js`, `alerts.js`).
   - Base look-and-feel: Bootstrap 5 is vendored under
     `frontend/bootstrap/` — check there before adding a new utility class
     system.
3. Follow the existing page-init pattern: define `window.initPage()` in the
   page's JS file; let `app.js` call it. Don't add a second
   `DOMContentLoaded` listener (see Workflow B, step 3).
4. If the change touches live-updating stats (drone-view, dashboard), trace
   the Firebase listener in that page's JS back to the Firestore field
   names in `backend/drone_conn/firebase_client.py` so the UI reads a field
   that's actually written.
5. **Verify:** load the page through the running Flask server
   (`http://localhost:5000/...`, not `file://`), exercise the changed flow
   in the browser, and check the console for errors. There's no visual
   regression tooling or screenshot test in this repo — a manual look is
   the check.

## Relevant files quick-reference

| Task area | Files |
|---|---|
| Drone API / detection endpoints | `backend/drone_conn/routes.py`, `detection.py` |
| Firestore read/write logic | `backend/drone_conn/firebase_client.py` |
| Stream connection / MediaMTX | `backend/drone_conn/{stream_capture,service,mediamtx,process_manager,network}.py` |
| User management (admin) | `backend/app.py` (`/api/users/*`) |
| User management (farm manager) | `backend/app.py` (`/api/fm/users/*`) |
| Live detection UI | `frontend/js/drone-view.js` + role-specific `drone-view.html` |
| SPA navigation / page init | `frontend/js/app.js` |
| Auth + role routing | `frontend/js/auth.js` |
| Firestore security rules | `firestore.rules` |
| Setup / run instructions | `SETUP_INSTRUCTIONS.md` |

## What this skill can't tell you

There's no documented process in the repo for model retraining/replacing
`best.pt`, no deployment/hosting instructions beyond local dev, and no
styleguide or design-system doc beyond `tokens.css` itself. If a task needs
one of those, say plainly that the repo doesn't document it rather than
inventing a process.
