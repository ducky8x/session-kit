---
name: autonomous-mode
description: Toggle autonomous mode for this session. When on, stop asking clarifying questions and make the best-effort call instead, so work keeps running for a long stretch while the user is away from the keyboard. Invoking it once turns it on; invoking it again while it's on turns it off. Use when the user says "turn on autonomous mode", "go autonomous", "stop asking me things", "I'm stepping away, keep going", or similar, and when they ask for one task to be done that way ("autonomously do X", "do X in autonomous mode"), which turns it on for that task only.
---

# Autonomous mode

A toggle for the whole session or for one task. Its state lives in this session's state file, so it survives a summary of the chat (compaction) and a resume.

## Find the current state

Read this session's state file first: `~/.claude/session-kit/state/${CLAUDE_SESSION_ID}.json`. The session-kit hook also prints its path at session start as `State file: ...`. If the path above has no session id in it (it shows a placeholder, or the file name is just `.json`), use the hook's path.

- `autonomous.on` is `true`: this call turns the mode **OFF**.
- The file or the field is missing, or `autonomous.on` is `false`: this call turns it **ON**.
- A hook note such as `Session setup (restored): ... Autonomous: ON` after a summary or a resume means it's on, even when the conversation no longer shows the call that turned it on.
- Two exceptions keep it as it is. A task-scoped request while session scope is already on changes nothing (see "Scope"). If the user asked for a specific state ("turn it on") and it's already in that state, say so and change nothing.

Fall back to the conversation only when there's no session id or the state file can't be read. Then scan back for the most recent call of this skill: none, or one that turned it off, means this call turns it on. One that turned it on, with nothing since that turned it off, means this call turns it off. A task-scoped ON that has switched itself off counts as off.

Say the new state in one short line, such as `Autonomous mode: ON (this session)` or `Autonomous mode: OFF`. Don't ask the user to confirm the toggle.

## Save the state

Write the new state back to the state file. Read the file first, change only the `autonomous` object and `updatedAt`, and keep every other field, such as `workflow`:

```json
{
  "workflow": "multi",
  "autonomous": {
    "on": true,
    "scope": "task",
    "task": "fix the failing build",
    "keepAwakeTaskId": "b7k2xq",
    "heartbeatCronId": "c41d9e"
  },
  "updatedAt": "2026-01-01T12:00:00Z"
}
```

- `scope` is `"session"` or `"task"`. `task` names the task in a few words and is set only for task scope.
- `keepAwakeTaskId` is the id of the background keep-awake command, and `heartbeatCronId` the id of the heartbeat. Record each one when you start it, so you can stop it after a summary of the chat.
- When it turns off, save `"autonomous": { "on": false }`.

Use the Write tool with the absolute path, or a Bash heredoc. If the write is refused or fails, carry on, and say in one line that the setting won't survive a summary of the chat.

## Scope: session or one task

- **Session scope.** The user turns it on by itself ("turn on autonomous mode", `/session-kit:autonomous-mode` with no task), the `session-kit:start` skill turns it on, or a question went unanswered. It stays on until toggled off.
- **Task scope.** The user asks for a specific task to be done autonomously ("autonomously fix the build", `/session-kit:autonomous-mode` followed by a task). It's on for that task only. When the task is finished and you've given the final report, turn it off yourself: end that message with `Autonomous mode: OFF (task finished)`, stop keep-awake and the heartbeat, and save it as off. Normal behavior resumes from the next message.
- If session scope is already on when a task-scoped request arrives, nothing changes: it stays on after the task.

In the ON line, say which scope applies: `Autonomous mode: ON (this session)` or `Autonomous mode: ON (until <task> is done)`.

## Turning ON

State the following as a standing directive for the rest of the session, or for the task in task scope:

- Don't use `AskUserQuestion`, and don't pause in text to ask a clarifying question, for anything you can reasonably decide yourself. Pick the most sensible interpretation or default, note the assumption in one line, and keep going without waiting for a reply.
- Don't stop a multi-step task partway through just to report interim status and wait. Carry it through to completion, and report at natural milestones or at the end.
- This changes when you stop to ask, not what's safe to do. Still pause for irreversible or high-blast-radius actions that need explicit sign-off: force-pushing, dropping data, sending messages outside the session, spending money, deleting things you didn't create. Normal judgment about risk and reversibility still applies.
- If you hit a real blocker, such as missing credentials, contradictory requirements with no reasonable default, or something only the user can authorize, stop and say so. Autonomous mode means defaulting to a decision, not never stopping.
- Keep a running tally of every call you make on your own: each assumption picked, default chosen or decision taken without asking. At a natural stopping point (end of turn, a milestone, or completion), close with a short "Decisions I made" list, one line each, specific enough that the user can spot-check or override any of them. Leave the list out only if the turn needed no such calls, and don't pad it with routine steps.

## Keep the computer awake

When it turns on, in either scope, keep the computer from sleeping while work runs unattended. Only the main session does this: a subagent's background command ends with the subagent.

- Check for `caffeinate` with `command -v caffeinate`. It exists on macOS.
- If it's there, start `caffeinate -ims` as a background shell command (the Bash tool with `run_in_background`) and save the task id it returns as `keepAwakeTaskId`. `-i` stops idle sleep, `-m` stops disk sleep, and `-s` stops system sleep while on AC power. The display may still sleep, which is fine. Say it in the ON line, for example `Autonomous mode: ON (this session) · Mac kept awake`, and remind the user once to keep the Mac on power, with the lid open unless an external display is connected (closing the lid without one still puts it to sleep).
- If it isn't there, skip this step and say so in the ON line, for example `Autonomous mode: ON (this session) · keep-awake not available on this system`.
- If one is already running from earlier in the session, don't start a second.
- When the mode turns off (toggled off, or a task-scoped run finishes), stop that command with `TaskStop`, using `keepAwakeTaskId` from the state file.

## Keep going through usage limits

When the mode is on and a usage limit stops agents or workflows (the error says when the limit resets), don't end the run.

- In the main session, keep a recurring heartbeat with `CronCreate` at an off-minute schedule such as `7,37 * * * *`, and save its id as `heartbeatCronId`. It normally starts when agent work begins (see the next section). If it isn't running yet when a limit hits, start it then. Its prompt names the plan file and what was stopped. On every fire, it resumes each stopped agent with `SendMessage`, or a stopped workflow with `resumeFromRunId`, instead of starting duplicates.
- Keep a short plan file in the session's scratchpad directory, so each heartbeat knows what's next.
- If the limit is still in effect, the heartbeat does nothing and waits for the next fire.
- Keep the computer awake (see above).
- When the run is done or the mode turns off, delete the heartbeat with `CronDelete`, using `heartbeatCronId` from the state file.
- Tell agents to commit after each step, so a stop loses nothing.

## Keep going when agents fail or stall

When the mode is on, a failed, crashed or stalled agent or workflow never ends the run. Neither does finding no agents running while the plan file still lists work.

- Start the heartbeat as soon as autonomous work with agents begins, not only after a limit is hit.
- On every fire, the heartbeat also checks for failures and stalls. It reads the plan file, then checks each agent or workflow listed there: task notifications, the workflow's `journal.jsonl`, and agent transcript files that stopped growing.
- Resume a stopped agent with `SendMessage`. Resume a stopped workflow with the Workflow tool's `resumeFromRunId`; agents that already finished come back from cache.
- If resuming fails, start a fresh agent whose brief says what was already committed.
- Never start a duplicate of something still running.
- Before restarting, read the error. If the same step fails the same way twice, change the approach instead of retrying it unchanged: a smaller task, a different brief, or a fix for the cause.
- Note each restart and why in the plan file and in the "Decisions I made" list.
- When the run is done, delete the heartbeat with `CronDelete`.
- Agents inherit the session's model and effort: leave out `model` and `effort` unless the user names one.

## After a summary of the chat or a resume

- After a summary, keep-awake and the heartbeat are still running. Their ids are in the state file.
- After a resume, background commands and heartbeats from before have stopped. If unattended work is still under way, start them again as described above and record the new ids. Do this without toggling the mode.

## Recap format

Keep each line of the decisions list to the decision plus a few words of why, if the reason isn't obvious. Don't restate the whole task. For example:

```
Decisions I made:
- Kept the old config loader as a fallback, since two callers still use it
- Used port 8080 for the dev server because 3000 was taken
- Left the lint warnings in utils/ alone: they predate this task
```

## Turning OFF

Say plainly that normal behavior resumes: ask clarifying questions and confirm nontrivial decisions as usual for the rest of the session.

Then clean up, using the ids in the state file:

- Stop the keep-awake command with `TaskStop` (`keepAwakeTaskId`).
- Delete the heartbeat with `CronDelete` (`heartbeatCronId`).
- Save `"autonomous": { "on": false }`.

If an id is missing, for example because a write failed, look for the task or the scheduled job in the conversation or with `CronList`, and stop it there.
