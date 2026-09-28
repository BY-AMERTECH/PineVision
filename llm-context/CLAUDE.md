# CLAUDE.md — PineVision

Claude-specific guidance for working in this repository. This file does not
repeat what's shared with every agent — that lives in
[`AGENTS.md`](./AGENTS.md), which Claude should follow the same as any other
coding agent (structure, commands, conventions, verification steps).

## What's here vs. what's in AGENTS.md

- **`AGENTS.md`** — structure, dev commands, coding conventions, and how to
  verify a change. Shared instructions; not Claude-specific.
- **`knowledge.md`** — the project reference (what it does, data flow,
  dependencies, config, known gaps). Read this before forming an opinion
  about how something works.
- **`SKILL.md`** — step-by-step workflows for the common task shapes
  (add/change a feature, fix a bug, touch the UI) with the specific files
  each one usually touches.
- **This file** — how to use the three files above, and constraints
  specific to working as Claude on PineVision.

## How to use these files

1. Start with `knowledge.md` to orient — what the system does, the data
   flow diagram, and especially the **"Known limitations / open
   questions"** section. Several things in this repo are ambiguous or
   contradicted by its own docs (YOLO version, whether `FIXES_NEEDED.md` is
   current, role count). Don't resolve those ambiguities by guessing —
   either check the current source yourself or say the ambiguity remains.
2. For a concrete task, check `SKILL.md` for a matching workflow first —
   it lists the actual files a given task type touches, derived from how
   the codebase is organized, not a generic checklist.
3. `AGENTS.md`'s structure listing and conventions section are the fastest
   way to find "where does X live" without re-deriving it from scratch each
   time — but it's a snapshot from one inspection pass. If something looks
   wrong (a file moved, a role added, a fix landed), trust the live
   repository over this file and consider it worth updating (see
   "Keeping this folder current" below).

## Inspect before assuming — specific to this repo

This codebase has a documented history of its own docs going stale (see
`knowledge.md`'s notes on `FIXES_NEEDED.md` and the two-role
`project-documentation/*-summary.md` files predating `farm_manager`). That
pattern means:

- **Never cite `FIXES_NEEDED.md` as a live TODO list** without re-checking
  the referenced line/file — most of what it lists already appears fixed.
- **Never assume two roles (Admin/Client)** — the live code has three
  (`admin`, `farm_manager`, `client`). Check `backend/app.py` and
  `frontend/js/auth.js` if a task is role-sensitive.
- Before changing a JS page module, check whether it registers its own
  `DOMContentLoaded` listener in addition to `app.js` calling
  `window.initPage()` — that exact double-init bug pattern has recurred in
  this repo (see `AGENTS.md`'s conventions section) and is easy to
  reintroduce by copy-pasting from an older page.
- Before describing the detection model as "YOLOv8" or "YOLOv5"
  authoritatively, look at `backend/drone_conn/detection.py`'s actual load
  path (`ultralytics.YOLO(...)` vs. the `torch.hub` fallback) — the repo's
  own comments disagree with each other.

## Project-specific workflow constraints

- **No CI, no linter, no automated test suite exists.** Don't invent a
  command that "should" exist (`npm test`, `pytest`, a GitHub Action) —
  say plainly that verification here is manual (see `AGENTS.md` §
  "Making and checking changes" and `SKILL.md`'s verification steps per
  workflow).
- **Credentials and model weights are not in git.**
  `backend/serviceAccountKey.json` and `backend/best.pt` must already exist
  locally for the backend to run; never generate placeholder/fake versions
  of these into the repo, and never print or echo real contents of
  `serviceAccountKey.json` if you happen to read it.
- **Large binary/media files exist in this repo** (`best.pt` copies,
  `mediamtx.exe`, `output/*.ts` HLS segments). Don't read these into
  context; they're irrelevant to code changes and some are already
  gitignored — check `.gitignore` before assuming a file is tracked.
- **Flask serves the frontend directly** — when testing a frontend change,
  it must be loaded through the running Flask server
  (`http://localhost:5000/...`), not opened as a local `file://` path, or
  Firebase config and API calls will silently fail in ways unrelated to the
  actual change being tested.

## Keeping this folder current

If you discover during a task that something in `AGENTS.md` or
`knowledge.md` is now wrong (a fix landed, a file moved, a new role or
module appeared), update the relevant file in the same change rather than
letting `llm-context/` drift the way `FIXES_NEEDED.md` and the
`project-documentation/` summaries did. Keep edits scoped to the fact that
changed — these files are meant to stay short and non-duplicative, not to
accumulate a second copy of the codebase.
