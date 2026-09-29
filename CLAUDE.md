@AGENTS.md

## Claude Code specifics

- The shared rules are in `AGENTS.md` (imported above). Don't duplicate them here.
- Don't `@`-import `llm-context/knowledge.md`; an import loads it into every
  session. Read it on demand.
- Project skills live once under `.agents/skills/`. The matching entries in
  `.claude/skills/` link to those same files for Claude Code. Keep skills
  task-specific; do not duplicate shared rules from `AGENTS.md` or facts from
  `llm-context/knowledge.md`.
