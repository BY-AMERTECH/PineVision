# PineVision — Implementation Report (Phase 3)

> Historical snapshot (2026-09-22): its scheduled-scan rule references describe the application at that date. The Schedule Scan feature and its Firestore rule were subsequently removed; existing records were retained.

Companion to `AUDIT_REPORT_2026-09-22.md`. Covers what was actually changed, what was deliberately left alone, and how it was verified.

---

## 1. Issues Found
See `AUDIT_REPORT_2026-09-22.md` for the full write-up. In short: a Firestore rules gap that silently breaks most of the Farm Manager role, the core crop-health alert feed being invisible on 2 of 3 roles' Alerts/Dashboard pages, a Settings "Save" button that doesn't save, a scan-end flow that claims success even on backend failure, disabled report-export stubs where the data was already available, a dormant JS `ReferenceError`, and a mission-numbering collision bug — plus several lower-priority/documented-only items.

## 2. Features Completed

| # | Feature | Files modified | What changed | Expected user behavior |
|---|---|---|---|---|
| 1 | Farm Manager access to org-wide blocks/scans/monitoring_alerts/scheduled_scans | `firestore.rules` | Added `isFarmManager()` as an additional read (and, for `blocks`, update) clause alongside the existing `isAdmin()` clause | Farm Manager's Blocks, Block Detail, Dashboard, Flights & Scans, and Reports pages — which already queried these collections without a `userId` filter — now actually receive data instead of Firestore `permission-denied` |
| 2 | Crop-health alerts visible to Admin & Farm Manager | `frontend/pages/admin/alerts.html`, `frontend/pages/farm-manager/alerts.html` | Added a second real-time listener on `monitoring_alerts`, a `mapMonitoringAlert()` mapper (reusing the existing row shape), a one-time `blocks` lookup for block-name labels, and merged both alert sources before rendering; `markResolved()` now routes the update to whichever collection (`alerts` vs `monitoring_alerts`) the alert actually came from | The Alerts page and its KPI/badge counts now include the automatically generated "Critical bearing rate" / "High non-viable rate" etc. alerts, not just failed-login events |
| 3 | Settings "Save Changes" actually persists | `frontend/pages/admin/settings.html`, `frontend/pages/farm-manager/settings.html` | 13 Notification & Preference fields are now read/written through the existing `utils.updateSetting()` localStorage store (same mechanism already used for theme/font/auto-refresh) and restored on page load; Reset now clears them back to their HTML defaults | Changing a notification preference and clicking "Save Changes" now actually keeps that value after a page reload, instead of silently resetting while still showing "Settings saved successfully" |
| 4 | Scan-end failure notification | `frontend/js/drone-view.js` | `handleEndScan()` now checks `stopDetection()`'s return value and shows a warning toast ("...final save may not have completed...") instead of the success toast when it returns `false` | If ending a scan fails on the backend, the operator is told, instead of seeing a generic "Scan session ended" success message |
| 5 | Report CSV export | `frontend/pages/client/reports.html`, `frontend/pages/farm-manager/reports.html`, `frontend/pages/admin/reports.html` | Reused the existing Blob/`createObjectURL` CSV pattern from `admin/activity.html`'s `exportCSV()`; wired the previously-disabled "Export CSV" buttons (client/farm-manager summary report) and the previously-disabled per-row "Download" button (admin) to real handlers | Clicking Export CSV / Download now downloads an actual `.csv` file of the report/row data already computed on screen |
| 6 | `utils.buildInlineBar()` latent `ReferenceError` | `frontend/js/utils.js` | Renamed the shadowing local variable | A future/edge-case call with no explicit color no longer throws; behavior is unchanged for every existing caller (all of which already pass a color) |
| 7 | Mission-number collision | `frontend/js/flight.js` | New mission numbers are now derived from the highest existing `MISSION #N`, not `array.length + 1` | Deleting a mission and creating a new one no longer reproduces an existing mission's number |

## 3. Features Not Implemented

- **PDF export** (client/farm-manager/admin Reports) — left as the existing "coming soon" stub. No PDF library or backend PDF route exists anywhere in the project; adding one is a new architectural decision the task instructed not to make unprompted. *(documented in the audit report, section "Requires Further Investigation")*
- **Admin/Farm Manager Dashboard "Active Alerts" KPI and recent-alerts panel** — still counts only the `alerts` (login-security) collection, not `monitoring_alerts`. I scoped this out after reading the dashboards' data-loading code: it's a single 7-query `Promise.all` that also feeds an hourly-bucketed analytics sparkline, and merging a second alert source into it correctly (counts, recent list, *and* the sparkline bucketing) is materially riskier than the same fix on the dedicated Alerts pages, which are simpler and already fixed (#2 above). Recommend a follow-up pass scoped to just that file once someone can test it live.
- **Configurable alert thresholds, hardcoded drone name, recurring/automated scan scheduling, duplicate `getStatusClass()`/threshold inconsistencies across pages** — all documented in the audit report as Medium/Low priority or "Requires Further Investigation," not implemented, either because they touch the protected `detection.py`, would change displayed business-logic values without product sign-off, or would require inventing new architecture.
- **Client Dashboard alert summary/banner** — doesn't exist at all currently (not a regression, never built); flagged for a separate pass since it's new UI, not a reconnect of existing UI.

## 4. Drone/Detection Findings

All confirmed via read-only inspection of `backend/drone_conn/detection.py`, `firebase_client.py`, `routes.py` — **none were modified**. Full detail in the audit report's "Drone / Detection Issues — DO NOT MODIFY" section:

1. Residual race window in the upload-video concurrency guard (`detection_active` cleared slightly before finalization completes).
2. RTSP-vs-HLS backend capture fallback unverified in production network conditions.
3. Frontend 15s stream-loss timeout vs. backend's own reconnect window are uncoordinated.
4. `detect_frame()`'s class-name normalization silently drops unrecognized `best.pt` output classes.
5. Alert thresholds (60/75, 18/25, 10/15) are hardcoded in `detection.py`, not configurable — no UI currently promises otherwise, so nothing is user-facing broken, just non-configurable.

All five were already known to a prior pass (`Claude outputs/PineVision_Drone_Pipeline_Fixes.md`, 2026-09-18) and left as intentional follow-ups; this audit did not add anything new to that list and touched zero lines in any drone/detection file.

## 5. Files Modified

1. `firestore.rules`
2. `frontend/js/utils.js`
3. `frontend/js/flight.js`
4. `frontend/js/drone-view.js` *(UI notification only — see below)*
5. `frontend/pages/admin/settings.html`
6. `frontend/pages/farm-manager/settings.html`
7. `frontend/pages/client/reports.html`
8. `frontend/pages/farm-manager/reports.html`
9. `frontend/pages/admin/reports.html`
10. `frontend/pages/admin/alerts.html`
11. `frontend/pages/farm-manager/alerts.html`

**`drone-view.js` note:** the only change is in `handleEndScan()` — capturing `stopDetection()`'s already-existing return value and branching the toast message. No timing, sequencing, or control-flow change to the actual stop-detection call, and no other drone/detection file was touched.

## 6. Testing Performed

- `node --check` on every modified `.js` file and on the extracted inline `<script>` content of every modified `.html` file — all passed (no syntax errors).
- Manual brace/parenthesis balance check on `firestore.rules` (no `firebase` CLI project configured in this environment to run a live rules simulator against).
- Cross-referenced every `onclick`/`onsubmit`/`onchange` handler across all 34 frontend pages (including their linked shared `.js` files) against actual function definitions — zero orphaned handlers found, before and after these changes.
- Line-by-line diff review of every changed file against its original, confirming each diff matches only the intended fix.
- Traced the `monitoring_alerts` merge through every consumer in `alerts.html` (`renderMetrics`, `renderSecondaryStats`, `applyFilters`, `updateNavBadge`, `openDetail`, `markResolved`) to confirm none of them assume every row is a login-security event in a way that would break.
- Confirmed via `find`/`diff` that no file under `backend/` was ever staged, opened, or written during this session.

**Not possible in this environment:** actually running the Flask server, a live Firestore project, or a browser against the changed pages — this sandbox has no `device_bash` access to the linked computer's Python venv/MediaMTX/Firebase credentials, matching the same limitation the prior drone-pipeline fix pass noted. All verification above is static (syntax + cross-reference + manual trace), not a live run.

## 7. Regression Check

- **Authentication / role-based access:** not touched. `auth.js`, `app.py`'s token-verification helpers, and the `/api/fm/*` routes are unchanged.
- **User / Farm Manager / Super Admin functionality:** Farm Manager gains read access it was silently missing (fix, not a behavior change for Admin or Client — their existing rule clauses are untouched, verified in the rules diff). Admin and Client alert/report/settings flows keep their exact prior behavior plus the fixes; nothing that previously worked was rewired.
- **Fruit Block functionality:** no changes to any block CRUD code path (`blocks.html`, `blocks-view.html` untouched on all three roles). The only Firestore-rules change affecting blocks is the added Farm Manager read/update clause — the existing owner/admin clauses are unchanged.
- **Existing navigation:** no navigation/routing code touched.
- **Existing CRUD functionality:** no Add/Edit/Delete handler was modified except the two new, additive CSV-export handlers and the settings-save extension (which only adds persistence to fields that previously did nothing).
- **Existing notifications:** all existing toasts/success paths are unchanged; only new failure-path messaging was added (End Scan) and previously-fake success messaging was made real (Settings Save).
- **Existing Firebase/Firestore functionality:** every existing rule clause (owner-scoped access for `blocks`/`scans`/`monitoring_alerts`/`scheduled_scans`, `isAdmin()` full access, `users` rules, `activity_logs`/`alerts` rules) is byte-for-byte unchanged except the additive Farm Manager clauses.
- **Existing API functionality:** no Flask route was added, removed, or modified.
- **Existing scan functionality / drone connection / streaming / YOLO / DeepSORT / tracking / counting:** unchanged — confirmed no file under `backend/` was touched, and the one `drone-view.js` edit is a post-hoc UI notification with no effect on the stop-detection call's timing or parameters.
