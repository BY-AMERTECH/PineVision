@AGENTS.md

## Claude Code specifics

- The shared rules are in `AGENTS.md` (imported above). Don't duplicate them here.
- Don't `@`-import `llm-context/knowledge.md`; an import loads it into every
  session. Read it on demand.
- This repo defines no project skills. Claude Code loads skills from
  `.claude/skills/`, not `.agents/skills/`; add one there only if a task-specific
  procedure earns it.
