# Contributing to ClipMind

Standard operating procedures for everyone, humans and AI agents alike. Read [`AGENTS.md`](AGENTS.md) first (architecture and stack rules); this file is the workflow.

## Golden rule
**Never commit to `main`.** Branch, open a PR, get it reviewed, merge. This applies to agents too.

## Branches
- Name: `type/short-desc`, e.g. `feat/clip-candidates`, `fix/ig-timeout`, `chore/repo-sops`, `spike/minds-http`.
- One branch per ticket. Keep them small.

## Commits
- Imperative subject, concise. Body explains why.
- No backticks in a `-m` message (the shell runs them). Plain words or single quotes.
- Reference the ticket: `Closes #12`.

## Pull requests
- Fill the PR template. Link the issue.
- At least one review before merge. On Free tier GitHub does not block this, so be honest and actually review.
- Squash merge. Delete the branch after.
- CI must be green.

## Definition of done
- Meets the ticket's acceptance criteria.
- Follows `AGENTS.md`. No reliability-critical control flow in the Mind.
- Tests pass once they exist. CI green.
- No secrets committed. `.env` stays local; only `.env.example` is tracked.
- Docs updated if behaviour changed.

## Tickets and the sprint
- Work is tracked as GitHub Issues, grouped into the current sprint.
- Pick an unassigned ticket, assign yourself, branch, PR, close it via the PR (`Closes #N`).
- Ticket format mirrors [`docs/tickets.md`](docs/tickets.md): goal, scope, acceptance, out of scope.

## Secrets
Never commit tokens or keys. Use env vars / Railway variables. See `AGENTS.md` sections 4 and 6.

## Agents
AI agents (Codex, Claude, and so on) follow this exact process: branch, PR, review, merge. No direct pushes to `main`.
