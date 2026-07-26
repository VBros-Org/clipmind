# ClipMind

@AGENTS.md

Claude: the rules in `AGENTS.md` are the working contract for this repo. Read them before any code. Full design in `docs/build-plan.md`.

The one rule that overrides convenience: the deterministic backend is the boss, the Minds agent is a headless cognitive service the backend calls. Never put reliability-critical control flow in the Mind.
