# PineVision — Drone Pipeline Fix Report

**Scope:** Implements fixes for the four issues confirmed by code tracing in `PineVision_Drone_Pipeline_Investigation.md` (Issues A–D). No other behavior was changed. Files were edited on the linked computer's copy of the project (`E:\PineVision\pinevision\PineVision`) and committed back in place.

---

## 1. Confirmed issues fixed, and their root cause

### Issue A — Ending a video scan mid-analysis corrupted the scan's final status (HIGH)
**Root cause:** `PineappleDetector.stop_detection()` is shared by the live-stream and uploaded-video pipelines. For video, clicking "End Scan" mid-analysis stops the background thread, which correctly writes `status: 'failed'` (no manifest ever created). `stop_detection()` then continued anyway and unconditionally called `complete_scan_session()`, overwriting that correct `'failed'` record with `status: 'completed', manifestReady: true` — pointing at a manifest file that was never written.

**Fix:** After joining the background thread, `stop_detection()` now re-reads the scan document's current status (new `firebase_client.get_scan_status()` helper). If the background loop already left it in a terminal state (`completed`/`failed`/`cancelled`), `stop_detection()` returns that status directly instead of calling `complete_scan_session()` again. The normal live-stream stop path is untouched — a live scan's status is still `'active'` at this point, so it falls through to `complete_scan_session()` exactly as before. As a side effect, this also protects the live-stream path from an analogous race (a dead stream writing `'failed'` in its own thread, followed by a delayed frontend `stopDetection()` call overwriting it).

### Issue B — Cross-category double counting in `detect_frame()` (HIGH)
**Root cause:** Duplicate prevention was three independent per-category sets (`unique_ids['bearing']`, `['non_bearing']`, `['non_viable']`). The membership check only looked at the set for *this frame's* category. Since a tracked object's classified category can change between frames (DeepSORT's `det_class` reflects the most recent match), the same `track_id` could get added to more than one category's set, inflating both the total count and the percentage splits.

**Fix:** Added `self.track_categories: Dict[track_id, category]`, populated once, the first time a track is confirmed. A later frame that reclassifies the same `track_id` is now ignored for counting purposes rather than being added to a second category. Verified with an isolated logic simulation (see §6) — a synthetic track that flips category three times went from being counted 3 separate times (old logic) to being counted exactly once, under its first-seen category (new logic).

### Issue C — `upload-video` silently discarded the `frame_skip` field it parsed (MEDIUM)
**Root cause:** `routes.py::upload_video()` parsed `frame_skip` from the multipart form but then called `start_video_scan(..., process_every_n_frames=5, ...)` with a hardcoded `5`, ignoring the parsed value.

**Fix:** The parsed `frame_skip` is now passed through to `start_video_scan()`. The form default was changed from `2` to `5` (clamped to a minimum of `1`) so that today's actual behavior — every 5th frame processed, since the frontend doesn't currently send this field — is unchanged. Any future frontend change that does send `frame_skip` will now actually take effect.

### Issue D — No concurrent-scan protection on the shared detector singleton (MEDIUM)
**Root cause:** `self.tracker`, `self.unique_ids`, and `self.detection_active` are instance attributes on one detector singleton with no per-scan isolation. `start_video_scan()`/`start_detection()` called `reset_tracking()` unconditionally, so a second scan request (two tabs, a stale retried request) while one was active would silently wipe the in-progress scan's tracker state.

**Fix:** Added a `threading.Lock()` plus a check-and-reserve at the top of both `start_detection()` and `start_video_scan()`: if `detection_active` is already `True`, the call now raises `ScanInProgressError` instead of proceeding. `routes.py` catches this in both `/start-detection` and `/upload-video` and returns `409 {"ok": false, "error": "scan_in_progress", "message": "..."}` (for uploads, the just-saved temp file is also cleaned up). This closes the race between "check" and "reserve" that a bare `if self.detection_active` check would still have left open.

---

## 2. Changed files

| File | Purpose of changes |
|---|---|
| `backend/drone_conn/detection.py` | Issues A, B, D. Added `ScanInProgressError`, `self.track_categories`, `self._scan_lock`; guarded `start_detection()`/`start_video_scan()`; fixed the dedup check in `detect_frame()`; added the terminal-status check in `stop_detection()`. Also annotated the already-dead `_video_scan_loop()` as unused (no behavior change). |
| `backend/drone_conn/firebase_client.py` | Issue A. Added `get_scan_status(scan_id)`, a small read-only helper. |
| `backend/drone_conn/routes.py` | Issues C, D. Wired `frame_skip` through in `/upload-video`; added `try/except ScanInProgressError` → `409` in `/start-detection` and `/upload-video`. |
| `frontend/js/drone-view.js` | Reliability hardening (Requirement 2, not a report issue by itself). `apiStartDetection()`/`apiStopDetection()` now go through a shared `parseApiResponse()` helper so a non-JSON error body (e.g. a raw proxy error page) degrades to a clear message instead of throwing and collapsing into a generic "Failed to start detection" toast — this is also what surfaces the new 409 `scan_in_progress` message to the user. |

No detection model, tracker, counting approach, database schema, or API shape was replaced — all four fixes are additive checks around the existing logic.

---

## 3. End-to-end flow (unchanged by these fixes, confirmed still intact)

**Live stream:** DJI Fly / ffmpeg → RTMP → MediaMTX → HLS (frontend playback via `hls.js`) + RTSP (backend frame capture via OpenCV, with HLS fallback) → `detect_frame()` (YOLOv8 + DeepSORT) → Firestore (`scans`, `blocks`) → frontend `onSnapshot` listeners update the stats panel live.

**Uploaded MP4 (two-phase):** Frontend loads the file locally for later playback and `POST`s it to `/api/drone/upload-video` → backend saves it to a temp dir and starts `start_video_scan()` in a background thread → `_video_scan_loop_sequential()` reads frames independently of the browser, runs `detect_frame()` on every Nth frame, and accumulates a manifest → periodic progress writes to Firestore → on completion, the manifest is written to disk **before** Firestore is told `manifestReady: true` → frontend fetches the manifest and plays the video locally at 1× with boxes drawn from the manifest.

**What changed in this flow:** only the *edges* — how "End Scan" mid-analysis resolves (Issue A), how a same-track reclassification is counted (Issue B), what stride a future caller can request (Issue C), and what happens if two scans are requested concurrently (Issue D, now a clear rejection instead of silent corruption).

---

## 4. How detection → tracking → counting → classification connect now

1. `detect_frame()` runs YOLO on the (possibly downscaled) frame, converts detections to `(bbox, confidence, class_name)` tuples, and hands them to the single `DeepSort` tracker instance, which assigns/updates `track_id`s.
2. Only `is_confirmed()` tracks are considered. Each track's most recent `det_class` is normalized into `bearing` / `non_bearing` / `non_viable`.
3. **New:** the track's category is looked up in `self.track_categories`. If already present, the track is skipped (already counted, under its original category). If not, the category is recorded and the track is added to that category's `unique_ids` set — this is the single point where Issue B was fixed.
4. `bearing_count + non_bearing_count + non_viable_count = total_count` — now guaranteed to equal the number of distinct physically-tracked pineapples, not inflated by reclassification.
5. `reset_tracking()` (called at the start of every scan) resets both `unique_ids` and the new `track_categories`, so a fresh scan starts with a clean slate — and, per Issue D, can no longer be triggered while another scan is still active.
6. On scan end, the final `unique_ids` sizes feed `complete_scan_session()`, which writes both the `scans` document and the `blocks` document's `bearingPercent` / `nonBearingPercent` / `nonViable` / `totalPineapples` fields — these are what the frontend's stats panel and scan history read directly, so backend counts and frontend display stay in sync automatically (no separate frontend aggregation).

---

## 5. Frontend error states and backend response format

Every `/api/drone/*` endpoint returns JSON with an `ok` boolean on both success and failure, plus `error` (a short machine-readable code) and `message` (human-readable) on failure. Status codes now in use:

- `200` — success
- `400` — missing/invalid request parameters (e.g. missing `block_id`, non-MP4 file)
- `409` **(new, Issue D)** — `error: "scan_in_progress"`, a scan is already active on this detector
- `500` — backend/processing failure (detector init failure, Firestore write failure, etc.)
- `503` — model failed to initialize

Frontend distinctions (in `drone-view.js`):
- **Network/backend unreachable:** `fetch` throws a `TypeError` → "Cannot reach backend. Ensure Flask server is running on port 5000."
- **Timeout:** `AbortSignal.timeout(...)` fires → `TimeoutError`/`AbortError` → "Upload timed out..." / equivalent.
- **Invalid upload:** handled before any network call (`.mp4` extension check) or via the backend's `400` body.
- **Backend/processing failure, model failure, scan-in-progress:** all arrive as parsed JSON with `ok: false` and a specific `message`, shown via `utils.showToast(...)`; a `500` is never presented as "cannot reach backend" — that message is reserved for actual network-level failures.
- **New:** `apiStartDetection`/`apiStopDetection` now always return a well-formed object (via `parseApiResponse()`) even if the response body isn't valid JSON, so a malformed error page can no longer get flattened into a generic message that hides the real HTTP status.

---

## 6. Checks run

- `python3 -m py_compile` on all three edited backend files — **passed**.
- `node --check` on the edited frontend file — **passed**.
- Two standalone logic simulations (pure Python, no project dependencies needed) that reimplement exactly the changed control flow and assert on it:
  - **Issue B simulation:** a synthetic track flipping category 3× across frames was counted 6 times under the old per-category-set logic and exactly once (under its first-seen category) under the new `track_categories` logic. **Passed.**
  - **Issue A simulation:** modeled `stop_detection()`'s control flow against a fake Firestore doc. Confirmed the old logic overwrites a `'failed'` write with `'completed'`; the new logic preserves `'failed'`; and a normal (never-interrupted) live-stream stop still reaches `'completed'` as before. **Passed.**
- No `pytest`/`eslint`/lint config exists anywhere in the project, so no project-native test/lint suite could be run.

---

## 7–8. End-to-end test and limitations

A real end-to-end run (drone/RTMP feed or an uploaded sample MP4 actually processed through YOLO + DeepSORT + Firestore) was **not performed**, for the same reasons the original investigation could not run one, plus one more specific to this session:

- No `device_bash` tool is available in this session, so nothing can be executed *on* the linked computer where the project's Python venv, MediaMTX, and `serviceAccountKey.json` actually live — file edits had to be made by staging files into this sandbox, editing them, and committing them back.
- This sandbox itself does not have `torch`, `ultralytics`, `deep_sort_realtime`, or `firebase_admin` installed, and installing the full ML stack here just to exercise a code path with no real Firebase credentials or drone footage would not have produced a trustworthy result — so instead I verified the two changed algorithms directly (§6), which is a stronger guarantee for the specific logic that changed than a smoke-test run without real credentials would have been.
- Sample MP4s do exist in the project (`test_videos/test.mp4`, `test2.mp4`, `test2-1sec.mp4`), and the model file `backend/best.pt` is present, but running them requires the venv/Firestore/MediaMTX stack that only exists on the linked computer.

**Recommendation:** on the linked computer, with the venv active, run one upload scan against `test_videos/test2-1sec.mp4` and verify: (a) clicking End Scan mid-analysis leaves the scan's Firestore doc at `status: 'failed'` with no manifest; (b) letting a scan complete normally still reaches `status: 'completed'`, `manifestReady: true`, and the manifest is fetchable; (c) starting a second upload while one is active returns HTTP 409 in the browser network tab instead of resetting the first scan's counts.

---

## 9. Unresolved items needing separate follow-up

These were flagged by the original investigation as requiring runtime verification or as out-of-scope architectural limitations, and remain so — none were touched by this pass, per the instruction to fix only the confirmed issues:

- **Magnitude of Issue B in real footage** — the fix is verified logically, but how often classifications actually flip on real video is still unmeasured.
- **RTSP-vs-HLS backend capture fallback** — unverified in production network conditions (a network blocking port 8554 would silently degrade to HLS capture).
- **Frontend 15s stream-loss timeout vs. the backend's own up-to-5-reconnect window** — these two reconnect mechanisms are still uncoordinated; a stream that recovers on the backend side slower than 15s will still surface as "Stream lost" to the user.
- **Model output class-name spellings** — `detect_frame()`'s normalization still expects specific string spellings; if `best.pt`'s actual `model.names` don't match, those detections are silently dropped (logged as `⚠️ Unknown class`). Not touched here since the report flagged it as needing verification against the actual model, not as a proven bug.
- **A narrow residual race in Issue D**: the concurrency guard blocks a second scan from starting while `detection_active` is `True` (i.e., while frames are actively being processed). For an uploaded video, `detection_active` is cleared a few lines *before* the final manifest write and `complete_scan_session()` call finish, so a new scan started in that narrow window could still call `reset_tracking()` while the first scan's finalization is reading `self.unique_ids`. This is a much smaller window than the one the report described (which this fix closes) and would require a larger restructuring of `_video_scan_loop_sequential()` to fully close — left as-is per the "small, focused changes" constraint.
- **Documentation hygiene** — `FIXES_NEEDED.md` (all items already fixed) and `DETECTION_TESTING_PLAN.md` (describes fixes — tracker init params, Kalman-only frame skipping, explicit NMS IoU, frame-skip formula, lag logging — that do not exist in the code) are both stale, as the investigation found. Not edited here; recommend the project team archive or rewrite them separately.
- **Dead code** — `_video_scan_loop()` (superseded by `_video_scan_loop_sequential()`) and `push_video_time()` (a documented no-op stub) were left in place and only annotated, not removed, to avoid unrelated risk.
