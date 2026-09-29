# PineVision — Agent Instructions

Shared rules for any coding agent (Claude Code, Codex, Freebuff, ...). Keep it
short. Architecture, data flow and verified facts live in
[`llm-context/knowledge.md`](llm-context/knowledge.md) — read its
"Detection pipeline" section before changing anything in `backend/drone_conn/`.

**Source code is the authority.** `FIXES_NEEDED.md`, `INTEGRATION_GUIDE.md`,
and `project-documentation/*` are historical notes (some predate the
`farm_manager` role). Re-check a claim in the code before relying on it, and say
so when something stays uncertain.

## Hard rules

1. **Credentials and weights.** Never print, echo, copy, or commit
   `backend/serviceAccountKey.json`. Never create fake credentials or
   placeholder weights. Don't read `backend/best.pt`, `mediamtx/mediamtx.exe`,
   or `output/*.ts` into context (large binaries).
2. **Live Firestore.** `python -m drone_conn.detection --video ...` and
   `backend/test_video_firebase.py` write real `scans`/`blocks` documents to
   the live project. Run them only if the user explicitly asks.
3. **Firestore write ownership.** Scan/block writes (create, progress,
   completion, manifest) belong in `backend/drone_conn/firebase_client.py`. Do
   not add new `db.collection(...)` writes elsewhere. Known existing
   exceptions in `detection.py`: `status: 'failed'` updates on `scans` and the
   `monitoring_alerts` batch in `check_thresholds_and_create_alerts()`.
   `app.py` owns `users` writes.
4. **Scan lifecycle invariants.** One scan at a time (`ScanInProgressError` →
   HTTP 409). Status goes `active` → `completed` | `failed`; never overwrite a
   terminal status (`stop_detection()` checks `get_scan_status()` first). For
   uploaded video, `save_detection_manifest()` must succeed *before*
   `complete_scan_session()` sets `manifestReady=True`. Count only confirmed
   DeepSORT tracks, with each track's class locked at first confirmation.
5. **Truthful verification.** There is no test suite, linter, or CI. Never say
   "tests pass". Report only checks you actually ran, and list what you could
   not run (for example, no Firebase key or drone in your environment).

## Commands

```bash
cd backend
python -m venv venv && .\venv\Scripts\activate   # Windows (source venv/bin/activate elsewhere)
pip install -r requirements.txt
python test_imports.py     # manual import smoke check, not pytest
python app.py              # Flask on http://0.0.0.0:5000, debug=True
```

Flask serves the frontend; open pages via `http://localhost:5000/...`, never
`file://`. Required local files, not in git: `backend/serviceAccountKey.json`,
`backend/best.pt`, `mediamtx/mediamtx.exe` (auto-launched by
`POST /api/drone/prepare`).

## Conventions

- **Backend:** Flask Blueprint `drone_bp` (`/api/drone`) in `routes.py`; user
  management routes live in `app.py`. Protect endpoints with the existing
  `_verify_admin_token()` / `_verify_farm_manager_token()` pattern (Firebase ID
  token + `role` looked up in Firestore); don't invent another auth scheme.
- Emoji `print` logging (`✅ ❌ 🚀`) is the house style; match it.
- **Frontend:** vanilla JS, no bundler. `app.js` calls `window.initPage()`; a page
  script defines `initPage` once and must **not** also register its own
  `DOMContentLoaded` listener (a recurring double-init bug).
- Three parallel role trees: `frontend/pages/{admin,client,farm-manager}/`.
  Many pages exist in more than one tree; check every tree the feature applies
  to. Roles are `admin`, `farm_manager`, `client` (never assume two).
- A new Firestore *collection* needs a `match` block in `firestore.rules`;
  new fields on existing collections usually don't. Rules are permissive, so
  check what writers need before tightening them.
- Read the whole function and its callers before editing; several past bugs
  came from a file changing without its caller.

## Verifying changes

- **Dependencies:** `python test_imports.py`.
- **Backend:** boot `python app.py` and expect `✅ Firebase connected
  successfully!` (needs a real key). Hit the changed endpoint and inspect the
  document it writes.
- **Detection pipeline:** needs a real video and writes to live Firestore; see
  rule 2 and knowledge.md "Testing without a drone".
- **Frontend:** load the page through Flask, exercise the flow, check the
  browser console.

## Keeping this current

If a task shows a statement here or in `llm-context/knowledge.md` is wrong,
fix it in the same change. Keep edits scoped; do not copy code-derivable detail
(file trees, line numbers) into these files.
