---
name: create-context
description: Create the .agentcontext file (a hidden per-project brief that load-context reads and update-context maintains) for the project in the current working directory. Use when the user says "make agent context", "create agent context file", "set up context for this project", or when load-context reports that none exists yet.
---

Create a `.agentcontext` file in the current working directory: a compact, standing brief so future sessions in this project start informed instead of asking the user to explain everything again.

## Steps

1. Check whether `.agentcontext` already exists in the current working directory. If it does, ask the user before overwriting it, even in autonomous mode: an overwrite can't be undone.
2. Gather what should go in it:
   - Look for a README (or a similar orientation doc) in the current working directory or the repo root.
   - Pull from the current conversation and from the user: what the project is, its structure and conventions, and any in-flight status worth tracking.
3. Write `.agentcontext` with this shape:
   - A one-paragraph orientation: what the project is, in plain terms.
   - A pointer telling the reader to read the README (name it, if one was found) for the full story. This file is a brief, not a copy of the README.
   - A **Structure & conventions** section: standing rules that would trip up a future session the same way twice. Only what's durable; don't restate what the README already covers well.
   - A **Current status** section: point-in-time facts (in-flight work, active branches, running services). Note that the `update-context` skill (`/session-kit:update-context`) keeps this section current.
4. Keep it terse: one line per fact, no padding.
5. If the folder is inside a git repo and `git check-ignore -q .agentcontext` fails, append `.agentcontext` to the clone's exclude file (`git rev-parse --git-path info/exclude` prints its path, usually `.git/info/exclude`). That file is private to this clone, so nothing tracked changes. Tell the user in one line, and mention that they can list it in `.gitignore` instead if they want the ignore rule shared.
6. Tell the user that `.agentcontext` was created (it's a hidden dotfile) and summarize what went into it.
