---
name: update-context
description: Update the current directory's .agentcontext file with what happened in this conversation (work completed, work still to do) and prune anything that's gone stale. Works in any project. Use when the user says "update context", "save this to context", "update the agent context".
---

Keep the current project's `.agentcontext` file accurate so a future session can pick up where this one left off without being briefed again.

## Steps

1. Look for a `.agentcontext` file in the current working directory.
   - If there isn't one, tell the user there's nothing to update and suggest running the `create-context` skill (`/session-kit:create-context`) first. Don't create one here.
2. Read it in full.
3. Scan this conversation for:
   - **Work completed**: what got done, fixed, shipped, or decided this session.
   - **Work still to do**: the next steps, in enough detail that a new session could continue without asking what's next.
   - **New conventions or gotchas**: standing rules found this session that would trip up a future session the same way twice.
   - **Stale content**: anything already in the file that this conversation resolved, replaced, or made irrelevant.
4. Edit the file:
   - Update the status section to reflect the current state: replace stale facts and finished work instead of appending to a growing log.
   - Delete anything superseded or no longer relevant. The file should stay lean, not collect history.
   - Add new conventions only if they're repeatable rules, not one-off facts.
   - Keep the existing terse, one-line-per-fact style.
5. Never touch the README or other docs. This skill only maintains `.agentcontext`.
6. Show the user a short diff-style summary of what changed (added, removed, updated), not just "done."

If nothing in the conversation is worth keeping, say so instead of editing.
