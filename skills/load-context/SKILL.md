---
name: load-context
description: Load the standing project context for the current working directory so you can start work right away without being re-briefed. Reads every .agentcontext file (a hidden per-project brief) found in the current directory and its ancestors, plus whatever README each one points to. Works in any project. Use when the user says "load context", "catch me up", "brief yourself", or at the start of a new session.
---

Brief yourself on the project in the current working directory so you can work right away without the user explaining the state again.

## Steps

1. Starting at the current working directory, walk up through every parent directory to the filesystem root, checking each one for a `.agentcontext` file. Keep only the directories that have one. For example, in `~/work/acme/api`, if only `~/work/acme` and `~/work/acme/api` have a `.agentcontext`, every other ancestor up to `/` is skipped.
   - If none has one (the current directory included), tell the user there's no `.agentcontext` here yet and suggest the `create-context` skill (`/session-kit:create-context`). Don't invent context or carry on as if briefed.
2. Read every `.agentcontext` found, in order from the most general (closest to root) to the current directory (most specific).
3. Each one should point to a README (or a similar doc) with the fuller story. Follow that pointer and read that doc too.
4. Take them in silently as layered context, general to specific. Don't dump the raw files back at the user. If a more specific `.agentcontext` conflicts with a more general one, the specific one wins.
5. Reply with a short brief, not a wall of text:
   - What the project is and its current stage, in one line.
   - The most relevant current-status facts (in-flight work, active branches, running services, anything time-sensitive), mostly from the most specific context.
   - Conventions or gotchas only if they're likely to matter right away, noting when one comes from a parent directory's context rather than the current project's.
6. How to finish depends on whether a request is waiting:
   - **Run on its own:** end by saying you're ready and asking what the user wants to work on. Don't invent a task.
   - **A request is already pending:** keep the brief to two or three lines, then go straight on to the request instead of asking what to work on. This is the case when the `start` skill (`/session-kit:start`) runs this skill at session start while the user's first request waits.

This skill only reads. Never edit any `.agentcontext` or README found along the way. To save new learnings at the end of a session, use the `update-context` skill (`/session-kit:update-context`); it only updates the current working directory's file.
