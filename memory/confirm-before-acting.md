---
name: confirm-before-acting
description: User wants confirmation of the plan before any code changes; do exactly what's asked
metadata:
  type: feedback
---

Before making any change, state in 1-2 lines what I'm about to do and wait for the user's confirmation. Do exactly what was asked — no unrequested optimizations, refactors, or extra "improvements." If I see a problem or a better approach, propose it and let the user decide instead of acting on it myself. Ask before, not after.

**Why:** The user repeatedly asked for one specific thing (scan only what's visible on screen) and I went off doing other things (rewrites, optimizations, diagnostics), costing them a lot of time across many turns. They were explicit: their time matters and they don't want to wait while I eventually circle back to the original request.

**How to apply:** Treat every task as scoped to exactly what was requested. Lead with a short "here's what I'll do" and pause for approval before editing code.
