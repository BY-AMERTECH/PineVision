# PineVision — Incomplete / Missing Feature Audit

> Historical snapshot (2026-09-22): its Schedule Scan findings describe the application at that date. The Schedule Scan feature was subsequently removed; do not use these references as a description of current functionality.

**Date:** 2026-09-22
**Scope:** Full repo (`backend/`, `frontend/`, `firestore.rules`) as it currently stands on disk — verified against source, not against the older `FIXES_NEEDED.md` / `CODEBASE_ANALYSIS.md` docs, which are stale (dated 2026-05-30/08-26). A prior session's `Claude outputs/PineVision_Drone_Pipeline_Fixes.md` (2026-09-18) already resolved every item in `FIXES_NEEDED.md` and several items in `CODEBASE_ANALYSIS.md` (block deletion, harvest status sync, Schedule Scan modal, trend chart, live bounding-box overlay, `alerts` UI reader) — those are **not** re-reported here; each was individually re-verified against the current file contents before being excluded.
**Hard constraint honored:** no drone connection / RTMP / MediaMTX / HLS / YOLO / DeepSORT / tracking / counting / frame-processing / scan-processing code was modified. Any issue discovered in that territory is listed in its own section, undisturbed.

---

## Critical / High Priority

### 1. Firestore rules never grant the Farm Manager role read access to `blocks`, `scans`, or `scheduled_scans` — the role's core pages are non-functional
**Screen:** Farm Manager → Blocks, Block Detail, Dashboard, Flights & Scans, Reports
**Current state:** `firestore.rules` grants `blocks`, `scans`, `scheduled_scans` read/write only to the document owner (`resource.data.userId == request.auth.uid`) or `isAdmin()`. There is no `isFarmManager()` clause on any of these three collections — only `activity_logs` and `alerts` grant Farm Managers read access.
**Evidence:** `firestore.rules:42-81` (rule set); `frontend/pages/farm-manager/blocks.html:931` (`collection("blocks").get()`, no `userId` filter — expects to see every client's blocks); `frontend/pages/farm-manager/blocks-view.html:539`; `frontend/pages/farm-manager/dashboard.html:864` and `frontend/pages/farm-manager/flights-scans.html:488`/`frontend/pages/farm-manager/reports.html:700` (`collection("scans")`, unfiltered); `frontend/pages/farm-manager/blocks.html:1350` (`.update()` on an arbitrary block's document for the Edit-Block feature). Every one of these reads/writes a document whose `userId` is a *client's* uid, never the signed-in Farm Manager's — under the current rules every one of them is denied by Firestore with `permission-denied`.
**Expected behavior:** A Farm Manager should see and (where the UI already offers it) edit every client's blocks/scans, the same oversight visibility the UI was clearly built to provide (the pages already assume org-wide reads — this is a security-rules gap, not a missing feature).
**Priority:** **Critical** — this silently breaks 5 of the Farm Manager role's 10 pages (everything except Users, Alerts, Activity, Audit Logs, Settings, which go through the `/api/fm/*` Flask routes or already have a farm-manager rule clause).
**Recommended implementation:** Add `isFarmManager()` as an additional allow-clause alongside the existing `isAdmin()` clause on `blocks`, `scans`, and `scheduled_scans` (read on all three; `update` on `blocks` only, since that's the only write the farm-manager UI performs — no `create`/`delete`, matching what the pages actually implement). This is a pure permissions extension; no schema or business-logic change.
**Dependencies:** None — self-contained rules change. (Firestore rules are deployed separately from the app; this fix edits the rules file in the repo, matching how `firestore.rules` is already tracked there.)

---

### 2. `monitoring_alerts` (the actual crop-health alert engine) is invisible on the Admin and Farm Manager Alerts pages and dashboards
**Screen:** Admin → Alerts, Admin → Dashboard; Farm Manager → Alerts, Farm Manager → Dashboard
**Current state:** The backend's threshold engine (`detection.py: check_thresholds_and_create_alerts()`) writes every crop-health alert ("Critical bearing rate", "High non-viable rate", etc.) to the `monitoring_alerts` collection. `frontend/js/alerts.js` — used by `client/alerts.html` — correctly reads `monitoring_alerts` and is fully wired. **`admin/alerts.html` and `farm-manager/alerts.html` do not include `alerts.js` at all** (`admin/alerts.html:823-831`, `farm-manager/alerts.html:839-847` only load `auth.js`, `data.js`, `utils.js`, `app.js`). Each page instead has its own inline `loadAlerts()` (`admin/alerts.html:910-944`, mirrored in `farm-manager/alerts.html`) that reads only the `alerts` collection — which is exclusively **failed-login security events** written by `auth.js:298` (fields: `ip`, `device`, `type: 'failed_login'`). The same `alerts`-only query also drives the "Active Alerts" KPI card and "recent alerts" panel on `admin/dashboard.html:820-840` and `farm-manager/dashboard.html:839-852`.
**Evidence:** grep for `monitoring_alerts` across `frontend/` returns exactly one file: `frontend/js/alerts.js`. Every other alert-count/alert-list query in the Admin and Farm Manager pages targets `alerts` only.
**Expected behavior:** Admin and Farm Manager — the two roles explicitly responsible for "system-wide alert monitoring" per the product docs — should see the automatically generated crop-health alerts (the system's flagship automated feature) on their Alerts page and in their dashboard KPI/panel, not just login-security events.
**Priority:** **Critical** — the core "Automated Alert System" feature is completely invisible to 2 of the 3 roles.
**Recommended implementation:** Additive fix, no redesign: add a second Firestore listener on `monitoring_alerts` in `admin/alerts.html` and `farm-manager/alerts.html`, map each document into the same row shape the existing `mapAlert()` already produces (title/severity/timestamp/status/details), and merge the two arrays before rendering (`monitoring_alerts` rows show the block instead of an IP/device). Mirror the same merge into the two dashboards' KPI/recent-alerts Promise.all. This reuses the existing render/badge code paths; it does not replace the login-alert feature, only adds the missing collection alongside it.
**Dependencies:** None beyond confirming the desired combined sort order (recommended: interleave by timestamp, which the merge-then-sort approach naturally provides).

---

### 3. Settings "Save Changes" shows a success toast without saving most fields (Admin & Farm Manager Settings)
**Screen:** Admin → Settings, Farm Manager → Settings (Notifications & Preferences tab)
**Current state:** 12 fields (`account-email`, `digest-toggle`, `date-range-default`, `sound-toggle`, `email-alerts-toggle`, `push-toggle`, `inapp-toggle`, `sev-crit`, `sev-warn`, `sev-info`, `digest-freq`, `quiet-hours`, `session-timeout`) each call `markUnsaved()` on change, and the page shows an "unsaved changes" indicator plus a "Save Changes" button. `handleSaveAll()` (`admin/settings.html:1897-1900`, identical in `farm-manager/settings.html:1911-1914`) does nothing but `clearUnsaved()` and `utils.showToast("Settings saved successfully", "success")` — none of the 12 fields are read or persisted anywhere, and none are restored on page reload (only `theme`/`fontSize`/`autoRefresh`/`alertNotifications`/`compactView` are, via separate immediate-persist handlers that bypass Save entirely).
**Evidence:** `admin/settings.html:1897` (`function handleSaveAll() { clearUnsaved(); utils.showToast(...); }`); no `utils.updateSetting(...)` call anywhere near it; `frontend/js/utils.js:406-435` shows the existing generic `getSettings()/updateSetting()` localStorage-backed store that already covers theme/font/autoRefresh but was never extended to these fields.
**Expected behavior:** Clicking "Save Changes" should persist the values the user changed, and those values should still be there next time the page loads. Right now every one of those 12 controls silently resets on refresh while telling the user it saved successfully.
**Priority:** **High** — a real "fake success" pattern across two role's Settings pages, exactly the kind of gap the audit asked to find.
**Recommended implementation:** Extend `handleSaveAll()` to read all 12 field values and persist each via the existing `utils.updateSetting(key, value)`; add a restore step in the page's init function that populates each field from `utils.getSettings()`. No new storage mechanism — this is a straight extension of the pattern already used for theme/font/autoRefresh.
**Dependencies:** `account-email` in this section is explicitly labeled "Contact address for alerts and system reports" (not the Firebase Auth login email, which has its own separate, already-functional Change Password flow) — safe to store as a plain preference.

---

### 4. "Scan session ended" success toast shown even when the backend fails to finalize the scan
**Screen:** Client → Drone View (End Scan)
**Current state:** `handleEndScan()` calls `await stopDetection()` but discards its boolean return value (`frontend/js/drone-view.js:1142`), then unconditionally shows `utils.showToast('Scan session ended', 'info')` (`:1179`) and navigates to the block page. `stopDetection()` itself only `console.error`s on failure (`:634-659`) — there is no user-facing failure path at all.
**Evidence:** `frontend/js/drone-view.js:634-659` (`stopDetection()` returns `false` on failure but callers ignore it), `:1132-1186` (`handleEndScan()`).
**Expected behavior:** matches the task's explicit ask — "Receive appropriate notifications when scans fail." If the backend couldn't finalize the scan (Firestore write failure, stop-detection request failure, etc.), the user should be told, not shown a generic success message.
**Priority:** **High**
**Recommended implementation:** In `handleEndScan()`, capture `stopDetection()`'s return value and branch the toast: success → existing "Scan session ended" (info); failure → a warning toast such as "Scan ended, but the final save may not have completed — check Scans history." This is a pure UI-notification change; it does not alter the timing or behavior of the stop-detection call itself, so it does not touch protected drone/detection logic.
**Dependencies:** None.

---

### 5. Report CSV export is a disabled stub despite the data already being computed client-side
**Screen:** Client → Reports, Farm Manager → Reports, Admin → Reports
**Current state:** `client/reports.html:466-473` and `farm-manager/reports.html:564-568` render disabled "Export PDF" / "Export CSV" buttons with `title="... coming soon"` and no `onclick`. `admin/reports.html:678` renders a disabled per-row "Download" button, also "coming soon." Meanwhile `generateReport()` in the client/farm-manager pages already computes exactly the filtered `blocks` array the table renders from, and `admin/activity.html` (`:1788-1829`) already has a working, reusable CSV-export pattern (build a CSV string, `new Blob([csv], {type:'text/csv'})`, `URL.createObjectURL`, temporary `<a download>`).
**Evidence:** see line refs above; working reference implementation at `frontend/pages/admin/activity.html:1788-1829` (also duplicated at `farm-manager/activity.html:1804-1845`).
**Expected behavior:** matches the task's explicit ask under "Export and Download Functionality" — clicking Export CSV should download the report data; per the task's own instruction not to invent new reporting architecture, CSV (which has a working precedent) should be completed, while PDF (which has no library or precedent anywhere in the project — no jsPDF, no server-side PDF route) is correctly left as a documented gap rather than invented from scratch.
**Priority:** **High** (CSV) / documented-only (PDF, see Medium/Requires-Investigation below).
**Recommended implementation:** Reuse the exact Blob/`createObjectURL` pattern from `activity.html`'s `exportCSV()`. For `client/reports.html` and `farm-manager/reports.html`, wire the existing "Export CSV" button to a new `exportReportCSV()` that serializes the current filtered `blocks` array (already held in a module-level variable at report-generation time). For `admin/reports.html`, wire each row's "Download" button to export that single scan row's already-rendered fields.
**Dependencies:** None.

---

## Medium Priority

### 6. Latent `ReferenceError` in `utils.buildInlineBar()` when `color` is falsy
**Screen:** all pages that could call `utils.buildInlineBar(pct)` with no color argument (currently dormant — every live call site happens to pass a truthy color)
**Evidence:** `frontend/js/utils.js:128`: `const barColor = color || barColor(percentage);` — the `const` declaration shadows the outer `barColor` function in its own initializer (temporal-dead-zone), so if `color` is ever falsy this throws `Cannot access 'barColor' before initialization` instead of falling back to the color-by-value helper.
**Priority:** Medium (real bug, currently unreachable, cheap and safe to fix)
**Recommended implementation:** Rename the local variable (e.g. `resolvedColor`) so it no longer shadows the `barColor` function.
**Dependencies:** None.

### 7. Mission numbers can collide after a mission is deleted
**Screen:** Client → Flight Management
**Evidence:** `frontend/js/flight.js:304`: `const missionNumber = \`MISSION #${allMissions.length + 1}\`;` — based on the current in-memory array length, not a persistent counter. Deleting mission #2 from a list of 5 and creating a new one reproduces "MISSION #5".
**Priority:** Medium
**Recommended implementation:** Derive the number from `Math.max(0, ...allMissions.map(m => parseInt after "MISSION #")) + 1` instead of `.length + 1` — a same-file, same-function, one-line change with no backend/schema impact. (A fully collision-proof scheme needs a backend counter; out of scope for a minimal fix, noted below.)
**Dependencies:** None for the minimal fix; a guaranteed-unique scheme would need a backend-assigned counter (`/api/missions`), which does not currently exist — flagged in Requires Further Investigation.

### 8. Duplicate `getStatusClass()` / `buildMetricCard()` / `buildInlineBar()` / `formatNumber()` implementations with inconsistent thresholds and CSS classes
**Screen:** `blocks.html`, `blocks-view.html`, `dashboard.js`, `scans.js`, `alerts.js`, `utils.js` (client and farm-manager variants)
**Evidence:** e.g. `utils.js` health-status thresholds come from `data.getThresholds()`; `blocks.html`'s local `getStatusClass()` hardcodes `>=80`/`>=60`; `dashboard.js`'s hardcodes `>=75`/`>=60`. A block at the same bearing % can show a different health badge depending on which page is open.
**Priority:** Medium — real inconsistency, but fixing it means picking one canonical threshold and changing displayed classifications on some pages, which is a business-logic behavior change, not a wiring fix.
**Recommendation:** **Not implemented in this pass** — flagged for the project owner to confirm the canonical threshold values before any page's displayed classification is changed. Implementing this without that confirmation risks silently changing what counts as "healthy" on some pages, which the task's constraints explicitly caution against ("do not change existing calculation logic unnecessarily").
**Dependencies:** Needs a product decision on the canonical thresholds (60/75 vs 60/80 vs configurable).

### 9. Alert thresholds (60/75 bearing, 18/25 non-bearing, 10/15 non-viable) are hardcoded in `detection.py`, not configurable from any Settings UI
**Evidence:** `backend/drone_conn/detection.py:102-106`. No Settings page anywhere in the app presents these as editable values (admin/settings.html has one static descriptive label, not an input) — so there is no disconnected UI here, just a documented product gap.
**Priority:** Medium / **Drone-adjacent — not modified.** `check_thresholds_and_create_alerts()` lives inside `detection.py`, one of the explicitly protected backend modules ("Detection thresholds" is named in the hard-constraint list). Making thresholds configurable would require this function to read from Firestore/config instead of a hardcoded dict — exactly the kind of detection-pipeline change the task says to document, not perform, even though no UI currently promises this capability (so nothing is actually broken from a user's perspective).
**Recommendation:** Documented only. If the project wants configurable thresholds, that change should be scoped and reviewed separately since it touches `detection.py`.

---

## Low Priority / Polish

### 10. Hardcoded drone name ("DJI Mavic 3 Multispectral") shown regardless of what was actually used
**Evidence:** `frontend/js/scans.js:128`, `frontend/js/dashboard.js:172`, `frontend/js/flight.js:146,319`. The `scans` Firestore document schema (`firebase_client.py: create_scan_session()`) never captures a drone-model field at all, so there's nothing to read even if the frontend wanted to.
**Priority:** Low — cosmetic, and a real fix means adding a new field to the scan-creation write path in `detection.py`/`firebase_client.py`, which is protected/drone-adjacent territory.
**Recommendation:** Documented only, not implemented.

### 11. `daysAfterFlowering` dead field alias
**Evidence:** `frontend/js/dashboard.js:59`: `daf: data.daysAfterFlowering || data.daf || 0` — no write path ever sets `daysAfterFlowering`; the fallback to `data.daf` (which is what `blocks.html` actually writes) always fires. Harmless dead code, not a user-visible bug.
**Priority:** Low. Not implemented (removing it is a no-op change with no user-facing benefit and non-zero risk of typo).

### 12. `scans.js` re-fetches the same operator's `users/{uid}` document once per scan row
**Evidence:** `frontend/js/scans.js:88-98` — N redundant Firestore reads for a query that always returns the same `userId`.
**Priority:** Low (performance, not correctness). Not implemented — outside the audit's "incomplete feature" scope; flagged for awareness only.

---

## Quick Wins
(All included in the Critical/High/Medium items above — restated here per the requested grouping)
- #4 End-Scan failure toast (drone-view.js) — one function, ~6 lines.
- #6 `buildInlineBar` ReferenceError (utils.js) — one line.
- #7 Mission-number collision (flight.js) — one line.
- #1 Firestore rules Farm Manager clause — additive rule block, no app code touched.

---

## Requires Further Investigation

### A. True PDF export
No PDF library (jsPDF or similar) or backend PDF route exists anywhere in the project. Implementing real PDF export means adding a new dependency/architecture, which the task instructs not to invent unprompted. Recommendation: leave the "Export PDF … Soon" buttons as-is until the project owner picks an approach (client-side jsPDF vs. a new Flask endpoint that renders a PDF server-side).

### B. Recurring / automated scan scheduling
"Scheduled Scans" exist as manual calendar records only — explicitly documented in-code as such (`blocks-view.html` comment: "Manual scheduling only... No automation, no exports."). There is no mechanism, anywhere in the backend, that could turn a scheduled-scan record into an actually-triggered drone scan (that would require the backend to autonomously call into the connect/start-detection pipeline on a timer with no operator present at the drone — a new capability, and one that reaches directly into the protected drone-connection pipeline). Recommendation: leave as a documented, intentionally-scoped gap; do not implement without an explicit product decision, since any implementation would necessarily add new logic to the drone-connection call path.

### C. Client Dashboard has no alert summary/banner
`client/dashboard.html`/`dashboard.js` contain no alert count, alert list, or "critical alerts open" banner at all, though the older product docs describe one. Given the scale of the Alerts-visibility fix already planned for Admin/Farm Manager (#2), and that this would be new UI (not a reconnect of existing UI) on the Client dashboard, it's flagged for a follow-up pass rather than bundled into this one.

---

## Drone / Detection Issues — DO NOT MODIFY (documented only)

These were surfaced while reading `detection.py`/`firebase_client.py`/`routes.py` for cross-referencing. All are **already known and explicitly left unresolved** by the prior `PineVision_Drone_Pipeline_Fixes.md` pass (2026-09-18) — repeated here only so this audit has a complete record. **None were touched.**

1. **Residual race in the upload-video concurrency guard** — `detection_active` is cleared a few lines before the final manifest write and `complete_scan_session()` finish in `_video_scan_loop_sequential()`, so a new scan started in that narrow window could still call `reset_tracking()` while the first scan's finalization is still reading `self.unique_ids`. (`backend/drone_conn/detection.py`, per the prior investigation's §9.)
2. **RTSP-vs-HLS backend capture fallback is unverified** in production network conditions — a network blocking port 8554 would silently degrade to HLS capture without surfacing that to the operator.
3. **Frontend 15s stream-loss timeout vs. backend's own up-to-5-reconnect window are uncoordinated** — a stream that recovers on the backend side slower than 15s still surfaces as "Stream lost" on the frontend even though the backend would have reconnected.
4. **Model output class-name spellings** — `detect_frame()`'s normalization expects specific strings from `best.pt`'s `model.names`; a mismatch silently drops detections (logged as `⚠️ Unknown class`) rather than surfacing an error.
5. **Alert thresholds hardcoded in `detection.py`** (see Medium #9 above) — not configurable without editing the protected detection module.

*Impact if left as-is:* all five are narrow-window or environment-dependent; none block normal single-operator, single-scan usage, which is why the prior pass classified them as out-of-scope follow-ups rather than confirmed bugs needing an immediate fix.
