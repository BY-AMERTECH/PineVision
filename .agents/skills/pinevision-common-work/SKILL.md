---
name: pinevision-common-work
description: Use when adding or changing a PineVision feature, fixing a bug, or updating the vanilla JavaScript frontend. Guides code navigation, scope, and project-specific verification.
---

# PineVision common feature and bug workflow

Use this skill for ordinary feature work, bug fixes, and frontend changes. For changes to YOLO/DeepSORT, scans, streams, MediaMTX, or scan-related Firestore writes, use the more specific `pinevision-detection-pipeline` skill as well.

## Before editing

1. Read `AGENTS.md` and the relevant section of `llm-context/knowledge.md`. Source code is authoritative; treat `FIXES_NEEDED.md`, `INTEGRATION_GUIDE.md`, and `project-documentation/` as historical until verified.
2. Trace the current behavior through the function and its callers before changing it. Keep the patch limited to the request.
3. For role-specific frontend work, check whether the page exists in `frontend/pages/admin/`, `client/`, and `farm-manager/`; update only the role trees the request applies to.

## Choose the owning layer

- Flask user-management routes and frontend serving: `backend/app.py`.
- Drone HTTP API: `backend/drone_conn/routes.py`.
- Scan/block Firestore writes: `backend/drone_conn/firebase_client.py`.
- Shared frontend navigation and page initialization: `frontend/js/app.js`; authentication and role routing: `frontend/js/auth.js`.
- Page behavior and styles: corresponding files under `frontend/js/`, `frontend/css/`, and `frontend/pages/<role>/`.
- Firestore security rules: root `firestore.rules`; check writers before changing access.

Follow the existing Flask, token verification, vanilla JS, and CSS conventions described in `AGENTS.md`. Page scripts should define `window.initPage()` and must not add another `DOMContentLoaded` listener; `app.js` calls the initializer.

## Verify honestly

- Frontend: use the running Flask app at `http://localhost:5000/...`, exercise the changed flow, and check the browser console. Do not use `file://`.
- Backend: use the relevant manual check described in `AGENTS.md`; app startup needs the local Firebase key.
- Never run detection scripts that write live Firestore unless the user explicitly asks.
- Report the checks actually run and any environment-dependent checks skipped. This repository has no automated test suite, linter, or CI.
