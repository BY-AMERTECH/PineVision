# PineVision Firestore Security Rules — Audit, Comparison & Final Ruleset

Date: 2026-09-22

## A. Current Rules Audit (what is actually deployed)

The source of truth is `E:\PineVision\pinevision\PineVision\firestore.rules`, read directly from disk. There is **no `firebase.json` or `.firebaserc`** anywhere in the project, so the rules are not deployed via the Firebase CLI — they must be copy-pasted into the Firebase Console by hand. `firestore.rules` on disk is therefore the only record of intent, and it is the file this audit treats as ground truth, **not** the "proposed" rules pasted into the task.

The file's last-modified timestamp (2026-09-22 15:14:58 UTC) is *newer* than `project-documentation/AUDIT_REPORT_2026-09-22.md` (13:23) and `IMPLEMENTATION_REPORT_2026-09-22.md` (13:35). Those two documents describe a prior session that added `isAdmin()`/`isFarmManager()` role-aware clauses to fix Farm Manager access. That version is **gone** — the file on disk right now has been reverted (or overwritten) to a much older, flat, non-RBAC version:

```
users:             read: if true (public, no auth)  |  create/update/delete: if auth != null
blocks/scans/monitoring_alerts/missions:  read/create/update/delete: if auth != null  (no ownership check at all)
scheduled_scans:   read/update/create: owner-only
activity_logs:     read: if auth != null  |  create: if true
alerts:            read/create/update/delete: if auth != null  (create additionally: if true)
```

In effect: **any signed-in user, regardless of role, can read, edit or delete any block, scan, monitoring alert or mission belonging to any other user**, and **any signed-in user can write any field — including `role` — on any user document**, including their own (trivial self-promotion to `admin`) or anyone else's. `/users` is also fully world-readable with no authentication at all. There are no `isAdmin()`/`isFarmManager()` helpers and no role checks anywhere. This is materially *more* permissive than either the old rules referenced in the project docs or the "proposed" rules in this task — it is the actual, current exposure.

## B. Proposed Rules Audit

The proposed rules introduce `isAdmin()` / `isFarmManager()` helpers and, for the first time, real per-role and per-owner scoping on every collection. Relative to what's actually deployed (section A), this is a large security improvement: ownership checks appear on `blocks`/`scans`/`monitoring_alerts`, `/users` is no longer world-readable, and `activity_logs`/`alerts` reads are restricted to admin/farm_manager. Structurally it is close to correct — independent verification against the app's own Firestore queries (below) confirms the `blocks`/`scans`/`scheduled_scans`/`missions` clauses match real usage almost exactly.

## C. Compatibility Issues Found (proposed rules vs. actual app behavior)

Verified by reading `auth.js` and every page's inline scripts, and cross-checking every `collection(...)`, `where(...)`, `.get()/.update()/.delete()/.set()/.add()` call against the proposed rule for that path.

1. **Username login would break entirely.** `auth.js login()` runs `db.collection('users').where('username','==', input).limit(1).get()` *before* `signInWithEmailAndPassword` — i.e., while `request.auth == null`. The proposed `allow list: if request.auth != null;` denies this unconditionally, so anyone logging in with a username instead of an email could never sign in. (Email-based login is unaffected.)

2. **`lastLogin` update breaks for every non-admin on every login.** Immediately after sign-in, `auth.js` runs `db.collection("users").doc(uid).update({lastLogin: ...})` for the signed-in user regardless of role. The proposed `allow write: if isAdmin();` on `/users` denies this for `client` and `farm_manager` accounts. It's wrapped in a try/catch so login still succeeds, but the field silently stops updating for two of the three roles.

3. **Farm Manager's direct "Suspend User" action breaks.** `admin/alerts.html` and `farm-manager/alerts.html` both contain a `suspendUser()`/similar handler that runs `db.collection('users').where('username','==',u).limit(1).get()` then `.ref.update({status:'disabled'})` directly from the client — not through the backend API. Under the proposed `allow write: if isAdmin();`, this fails for Farm Manager.

4. **Farm Manager can't resolve `monitoring_alerts`.** The proposed rule is `allow update, delete: if owner || isAdmin();` — no `isFarmManager()`. But `markResolved()` in both `admin/alerts.html` and `farm-manager/alerts.html` is the *same* function, used from Farm Manager's "Account Alerts" page to resolve crop-health (`monitoring_alerts`) alerts belonging to any client. This would fail under the proposed rule.

5. **Farm Manager can't resolve `alerts` (login-security alerts).** Same `markResolved()` function also updates the `alerts` collection when the alert's `source` isn't `"monitoring"`. The proposed rule (`allow update, delete: if isAdmin();`) has no farm_manager clause, so this fails too.

6. **`user_settings` is entirely unrules'd — in both versions.** `frontend/js/alerts.js` reads/writes `db.collection('user_settings').doc(uid)` for the "Save Thresholds" feature on the Alerts page. Neither the currently deployed rules nor the proposed rules mention this collection at all, so Firestore's default-deny already silently breaks this feature today, independent of anything else in this audit.

Everything else checked out compatible: `blocks`/`scans`/`scheduled_scans` reads and writes (including Farm Manager's unfiltered `collection("blocks").get()`, `collection("scans").orderBy(...)`, and block-edit `update()` calls, and the read-only nature of Farm Manager's `scheduled_scans` access) line up with the proposed rules exactly, as does `activity_logs`/`alerts` creation and admin/farm_manager-only reads.

## D. Security Issues

**Currently deployed rules:** effectively no authorization model at all — public read of all user profiles; any authenticated account (including a freshly created `client`) can grant itself `role: admin`; any authenticated account can read, edit or delete any other user's farm blocks, scans, alerts, or missions. This is a critical, exploitable privilege-escalation and data-exposure issue in production right now.

**Proposed rules:** a large improvement, but: (a) `allow get/list: if request.auth != null` on `/users` lets *any* signed-in client — not just admin/farm_manager — read every other user's full profile (email, full name, role) by id or by listing, which the app never actually needs (clients only ever fetch their own profile); (b) `allow write: if isAdmin();` on `/users`, as shown above, is *too* strict and breaks real functionality rather than too loose; (c) no protection against a `client` writing to `/user_settings` for other users, though that's moot since the collection isn't covered at all; (d) `activity_logs`/`alerts` `allow create: if true` remains an open, unauthenticated write surface (documented separately in `project-documentation/CODEBASE_ANALYSIS.md §7.1`) — accepted as necessary here per the task's own instruction not to remove it without a replacement logging mechanism, but it remains a quota/abuse risk worth flagging.

## E. Recommended Final Rules — what changed and why

Starting from the proposed rules (not the deployed ones, since the deployed ones have essentially no RBAC to preserve), the final ruleset:

- Adds `isFarmManager()` to `monitoring_alerts` update and `alerts` update (fixes #4, #5).
- Narrows `/users` `get`/`list` to: self, or admin/farm_manager (management + detail views) — removing the "any signed-in client can browse every user" gap, verified safe because no client-role page ever lists or fetches another user's document.
- Adds one anonymous, size-capped (`limit(1)`) `list` allowance for `/users`, matching exactly the shape of the pre-login username lookup, so login keeps working without reopening the collection to bulk enumeration (fixes #1).
- Replaces the admin-only `/users` write with: admin (full), self (any field except `role`, which fixes self-escalation while preserving the `lastLogin` write — fixes #2), and farm_manager (any non-admin target, cannot grant `role: admin` — fixes #3, and enforces "Farm Manager cannot manage Super Admin accounts / cannot promote to admin" at the rules layer, not just in client-side JS and the backend, as defense in depth).
- Adds a new, minimal `/user_settings/{userId}` rule (owner-only read/write) that neither the deployed nor the proposed rules had, fixing the pre-existing "Save Thresholds" bug (#6).
- Leaves `blocks`, `scans`, `scheduled_scans`, `missions`, `activity_logs` unchanged from the proposal — they already match verified app behavior.

The final rules file is at `/mnt/user-data/outputs/firestore.rules` (implemented on disk at the project's `firestore.rules` path — see section F).

---

## F. Changed Files

| File | Change |
|---|---|
| `E:\PineVision\pinevision\PineVision\firestore.rules` | Replaced in full. See diff summary in section E. This is the only file changed — no frontend, backend, or unrelated files were touched. |

## G. Final Permission Matrix

| Collection | User/Client | Farm Manager | Super Admin |
|---|---|---|---|
| `users` | get/list: self only. update: self, but cannot change own `role`. No create/delete/list-others. | get/list: any user (management). update: any non-admin target, cannot grant `role: admin`. No create/delete. | Full (get/list/create/update/delete, any user). |
| `user_settings` | Own doc only (read/write). | Own doc only. | Own doc only (not an admin console feature — matches app behavior). |
| `blocks` | Own docs: read/update/delete/create (create requires `userId == self`). | Org-wide read + update (Edit Block). No create/delete. | Full. |
| `scans` | Own docs: read (create/update/delete technically permitted to owner but unused — writes come from the backend Admin SDK). | Org-wide read. No write. | Full. |
| `missions` (unused/legacy) | Own docs only. | No access (unchanged from proposal — collection is dead code). | Full. |
| `monitoring_alerts` | Own docs: read/update (resolve)/create. No delete. | Org-wide read + update (resolve any client's alert). No delete/create. | Full. |
| `scheduled_scans` | Own docs: read/update(cancel/edit)/create. No delete (app never deletes, only cancels). | Org-wide **read-only**. | Full read/update/create (no delete rule exists for anyone, matching "never delete, only cancel"). |
| `activity_logs` | No read. Anyone (incl. unauthenticated) can create (login/failed-login logging). | Read. | Full. |
| `alerts` (login-security) | No read. Anyone (incl. unauthenticated) can create (failed-login alerts). | Read + update (resolve). No delete. | Full. |

## H. Verification Results

Verified by static analysis (no live Firebase project/CLI available in this environment — see Remaining Risks):

- **Login flow (all 3 roles):** traced `auth.js login()` end-to-end. Username lookup (unauthenticated `list`, `limit(1)`) → sign-in → self `get` on `/users/{uid}` for role → `redirectToDashboard(role)`. All three steps are permitted by the final rules for every role. Failed-login logging (`activity_logs` create, `alerts` create) confirmed unauthenticated-safe.
- **Role retrieval:** confirmed `role` is read from `/users/{uid}.role` immediately after auth in `auth.js`, and is never independently re-derived elsewhere in a way that could be rules-blocked.
- **User management:** admin's direct client-SDK CRUD on `/users` (create via `createUserWithEmailAndPassword` + `.set()`, `.update()`, `.delete()`, bulk status toggles) all map to `isAdmin()` in the final rules — unaffected, verified line-by-line in `admin/users.html`.
- **Farm Manager management of clients:** farm-manager/users.html's create/edit/reset-password/toggle-status all go through the backend `/api/fm/users*` endpoints (Bearer-token authenticated, Admin SDK, server-verified via `_verify_farm_manager_token()` in `backend/app.py`), which bypass Firestore rules entirely and independently enforce "cannot touch/create admin" — confirmed by reading `backend/app.py` lines ~303–410. The only *direct* Firestore write farm_manager performs against `/users` is the alerts-page "Suspend User" action, which the final rules explicitly accommodate (section E).
- **Farm Manager inability to manage Super Admins:** enforced twice — server-side in `backend/app.py` (`fm_update_user`/`fm_create_user`/`fm_reset_password`/`fm_toggle_status` all reject an `admin` target or an `admin` role assignment), and now also in the Firestore rules themselves (`resource.data.role != 'admin' && request.resource.data.role != 'admin'`), so a client-side bypass (e.g. calling the Firestore SDK directly from the browser console, skipping the backend) is still blocked.
- **Block viewing/editing:** client owner CRUD (`client/blocks.html`, `blocks-view.html`) and farm_manager org-wide read + update-only (`farm-manager/blocks.html`, `blocks-view.html`, confirmed no create/delete calls exist there) both verified against the final rules.
- **Scan viewing:** client owner reads and admin/farm_manager unfiltered `orderBy` reads (`admin/flights-scans.html`, `farm-manager/flights-scans.html`, `*/dashboard.html`, `*/reports.html`) all verified compatible — these rely on the fact that `isAdmin()`/`isFarmManager()` don't depend on document data, so an unfiltered query is legal under Firestore's per-document rule evaluation for list requests.
- **Mission functionality:** confirmed `missions` collection has zero references anywhere in `frontend/` — dead code, no functional risk either way.
- **Monitoring alerts:** confirmed both client-owner and admin/farm_manager-org-wide read paths, and the shared `markResolved()` farm_manager update path, against the final rules.
- **Scheduled scans:** confirmed farm_manager is read-only (no update/create/delete call exists in `farm-manager/blocks.html` or `blocks-view.html` for this collection), and that the app only ever "cancels" (status update) rather than deletes a schedule — final rules have no delete allowance for anyone, matching "historical records are not accidentally deleted."
- **Activity logs / Alerts:** confirmed unauthenticated create is exercised by real failed-login code paths in `auth.js`, `admin/alerts.html`, `farm-manager/alerts.html`; confirmed admin/farm_manager read and resolve (`alerts`/`monitoring_alerts`) paths; confirmed no client-role page reads either collection.
- **Existing Firestore queries:** every `collection(...)`/`where(...)`/`orderBy(...)` call across `frontend/js/*.js` and every page under `frontend/pages/{admin,farm-manager,client}/*.html` was enumerated via grep and individually checked against the corresponding rule. No incompatible query was found in the final ruleset (the four bugs found in the *proposed* rules, section C items 1–5, are all fixed).

## I. Remaining Risks / Not Verified

- **No live Firestore project or Firebase CLI in this environment.** These rules were validated by manual, exhaustive cross-referencing against every Firestore call found in the codebase — not against the Firebase Rules Playground/emulator or a real deploy. Before relying on this in production, run it through the Firebase emulator or Rules Playground with representative documents for each role, and do a real login as each of `admin`, `farm_manager`, and `client` test accounts.
- **The rules are not actually deployed by this change.** They were only edited in the project's `firestore.rules` file on disk. Since there's no `firebase.json`/CLI wiring, someone still needs to paste this file's contents into the Firebase Console (Firestore → Rules) — exactly as (it appears) happened before, and was apparently reverted since. Consider adding `firebase.json`/`.firebaserc` and deploying via `firebase deploy --only firestore:rules` so this doesn't silently drift again.
- **`user_settings` is a new rule with no prior precedent** in either the deployed or proposed rules. It's a narrow owner-only rule and low risk, but flagging it explicitly since it wasn't part of the original comparison scope.
- **`allow create: if true` on `activity_logs` and `alerts` remains an open, unauthenticated write surface** (quota/abuse risk, previously flagged in `project-documentation/CODEBASE_ANALYSIS.md`). Preserved per this task's explicit instruction not to remove it without a safe replacement for unauthenticated failed-login logging; a follow-up (e.g. Firebase App Check, or moving failed-login logging to a Cloud Function) would need its own separate review.
- **Farm Manager's direct "Suspend User" write path** (`alerts.html`'s `suspendUser()`) has no client-side check preventing it from targeting an admin account — the *client-side* code doesn't guard it (unlike `farm-manager/users.html`'s edit flow, which does). The final rules close this gap server-side, but it would be worth adding the same client-side guard for a consistent UX (out of scope for this rules-only task — noted, not changed).
- **Backend admin-SDK write paths** (`backend/drone_conn/firebase_client.py` writing `blocks`/`scans`, `backend/app.py`'s `/api/users` and `/api/fm/users` families writing `users`) were read but not executed/tested — they bypass Firestore rules by design (Admin SDK), so they are unaffected by this change, but their own server-side authorization was only reviewed by reading the code, not by running it.
