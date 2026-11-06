---
name: start
description: Set up how this session runs, single-agent or multi-agent, autonomous or not, and cloud agents or not, save the choice, then work that way. The session-kit SessionStart hook asks for it at the start of every new session. Also use mid-session when the user types /start or asks to switch ("go multi-agent", "switch to single-agent", "turn autonomous on for the session", "turn cloud agents on"), or asks to create a rules file for session-kit.
---

# Start

This skill sets three things for the session: the workflow (single-agent or multi-agent), whether it runs autonomously, and whether worker tasks may run as cloud agents. It saves them in a state file, so the setup survives a summary of the chat (compaction) and a resume.

## State file

This session's state file is `~/.claude/session-kit/state/${CLAUDE_SESSION_ID}.json`. The session-kit hook also prints it at session start as `State file: ...`, next to `Session id: ...`. If the path above has no session id in it (it shows a placeholder, or the file name is just `.json`), use the hook's path instead. Never write a state file without a session id in its name.

The file holds one JSON object. A missing field means not set.

```json
{
  "workflow": "multi",
  "autonomous": { "on": true, "scope": "session" },
  "cloud": { "on": true, "remote": "unknown" },
  "updatedAt": "2026-01-01T12:00:00Z"
}
```

- `workflow` is `"single"` or `"multi"`. This skill owns it.
- `autonomous` belongs to the `session-kit:autonomous-mode` skill, which adds the scope, the task and the ids of its background jobs. When you change `workflow` or `cloud`, keep the other fields as they are.
- `cloud` is the Cloud answer. Yes writes `{ "on": true, "remote": "unknown" }` and No writes `{ "on": false }`. This skill owns `cloud.on`. `remote` says whether cloud subagents really run in the cloud in this session: `"unknown"` until the first cloud task reports back, then `"available"` or `"unavailable"`, set as `cloud.md` in this skill's folder describes.

To update the file, read it if it exists, change only your fields, set `updatedAt` to the current time, and write the whole object back. Use the Write tool with the absolute path from the hook, or a Bash heredoc:

```bash
mkdir -p ~/.claude/session-kit/state
cat > ~/.claude/session-kit/state/${CLAUDE_SESSION_ID}.json <<'EOF'
{ "workflow": "single", "autonomous": { "on": false }, "cloud": { "on": false }, "updatedAt": "2026-01-01T12:00:00Z" }
EOF
```

If the write is refused or fails, carry on, and say in one line that the setup won't survive a summary of the chat.

## When to ask

Ask at the start of a new session, before acting on the user's first message. Skip the questions when:

- the first message already says how to run (for example "multi-agent, autonomous, cloud: ..." or "single-agent, no cloud: ..."). Use that, and ask only what it leaves open. "cloud" answers the Cloud question Yes, and "no cloud" answers it No;
- you are a subagent, or the session is non-interactive (print mode, `-p`). Don't ask anything and don't write `cloud`; work single-agent unless the request says otherwise;
- the hook restored a setup after a resume or a summary of the chat (`Session setup (restored): ...`), or the conversation already settled it.

## How to ask

Make one `AskUserQuestion` call with up to four questions: Workflow, Autonomous and Cloud every time, plus Discord when it hasn't been offered yet (see "Discord offer"). Don't mark any option "(Recommended)": this is the user's choice.

1. Question "Which workflow should this session run on?", header "Workflow":
   - **Single-agent**: "One agent does all the work itself."
   - **Multi-agent**: "This agent only manages: it sends tasks to worker agents, collects and combines their results, and handles the repo and git."
2. Question "Should this session run autonomously?", header "Autonomous":
   - **No**: "Ask me when a decision is mine to make."
   - **Yes**: "Don't ask me anything; decide, note the assumption, keep going."
3. Question "Use cloud agents for worker tasks?", header "Cloud". Mark neither option as the default:
   - **No**: "Worker agents run on this computer."
   - **Yes**: "In multi-agent sessions, tasks that don't need this computer run as cloud subagents once Claude Code offers them; until then they run here."
4. Only when the session-start hook printed `Discord: not offered yet.`: question "Set up Discord now?", header "Discord". Mark neither option as the default:
   - **Yes**: "Set up a private Discord server where each session gets a channel for its updates and your replies. Runs after these questions."
   - **No**: "Don't set it up. You can turn it on later with /discord on."

Then, in the same turn:

1. Write the state file: `workflow`; `"autonomous": { "on": false }` if the Autonomous answer was No; and `cloud`, which is `{ "on": true, "remote": "unknown" }` if the Cloud answer was Yes and `{ "on": false }` if it was No.
2. Say the result in one line, for example `Workflow: multi-agent · Autonomous: ON · Cloud agents: ON`.
3. If the Autonomous answer was Yes, invoke `session-kit:autonomous-mode`. That turns it on for the whole session.
4. If a `.agentcontext` file exists in the current folder or any parent folder, invoke `session-kit:load-context`. It keeps its brief short when a request is waiting. To check:

   ```bash
   d=$PWD; while :; do [ -e "$d/.agentcontext" ] && { echo "$d/.agentcontext"; break; }; [ "$d" = / ] && break; d=$(dirname "$d"); done
   ```

5. If Discord was offered, act on the answer (see "Discord offer").
6. Carry on with the user's first request.

Follow the same steps when you skipped the questions because the first message settled them.

## Discord offer

On macOS, while `~/.claude/session-kit/discord/config.json` doesn't exist (Discord was never offered or set up), the session-start hook prints `Discord: not offered yet.` Only then add the fourth question. Ask it even when the first message settled the other three, and only once in a session: a later `/start` doesn't ask it again.

- **Yes**: after steps 1 to 4, invoke `session-kit:discord`, which runs its guided setup. The user's first request waits until the setup is done or the user sets it aside.
- **No**: save the answer so it isn't offered again, then say in one line that Discord can be turned on later with `/discord on`:

  ```bash
  mkdir -p ~/.claude/session-kit/discord && chmod 700 ~/.claude/session-kit/discord
  [ -e ~/.claude/session-kit/discord/config.json ] || printf '{"offered":true,"enabled":false}\n' > ~/.claude/session-kit/discord/config.json
  ```

- **No answer**: write nothing and skip the setup, so the next session asks again. The rules for unanswered questions below don't pick an answer for this one.

## If the question goes unanswered

When an answer timeout is set, an unanswered question closes by itself with a note that the user may be away from the keyboard. Treat that as no answer: use **Single-agent**, **Autonomous: ON** and **Cloud: No**, say so, and follow the steps above.

## Standing rule: an unanswered question means work autonomously

For the rest of the session, whenever any `AskUserQuestion` comes back auto-continued because nobody answered:

- Take the option you'd recommend.
- Turn autonomous mode on by invoking `session-kit:autonomous-mode`, unless the state file says it's already on.
- Ask nothing more this session.
- In your next message, name the question that went unanswered and what you picked.

## Rules file

The user's standing rules live in `~/.claude/session-kit/rules.md`. The user owns that file and the plugin never overwrites it. The session-kit hooks load it into the session at startup, after `/clear`, after a summary of the chat and on resume, and into every subagent. A file of up to 8000 bytes loads in full. A larger one gets only a note telling the model to read it, so it should stay under 8000 bytes.

If there's no rules file and the user asks for one, copy the template from this skill's folder, without replacing an existing file:

```bash
mkdir -p ~/.claude/session-kit
[ -e ~/.claude/session-kit/rules.md ] || cp "${CLAUDE_SKILL_DIR}/rules-template.md" ~/.claude/session-kit/rules.md
```

Then tell the user to edit it, that it loads in full only while it stays under 8000 bytes, and that changes apply from the next session start, `/clear` or new subagent.

## Single-agent

Do the work yourself. Spawn subagents only when the user asks for them.

A Cloud answer of Yes is saved and restated, but a single-agent session sends nothing to cloud agents.

## Multi-agent

Choosing this is the user's explicit request to use subagents (the Agent tool) for the whole session. You are the coordinator, the agent the user talks to. Worker agents do the building.

You do these yourself:

- talking with the user: take requests, say which agent is on what, and report what came back;
- planning, splitting the work into tasks and writing the briefs;
- dispatching agents and tracking them;
- reading results, diffs and files to review and plan;
- making the decisions;
- the repo and git: branches, worktrees, commits, merges, a test run after each merge, and pushes when the user asks for them. Follow the project's own conventions (`CLAUDE.md`, `.agentcontext`, `CONTRIBUTING` and similar).

Everything that is real implementation goes to an agent: writing or editing code and docs, research, debugging, and verifying a change. If you can't tell whether a task is mechanical, treat it as work and dispatch it.

How to manage:

- Run agents in the background so you stay responsive to the user. Run independent tasks in parallel and dependent ones in order. Never put two agents on the same files, and don't duplicate an agent's work yourself.
- Write each brief so it stands alone. It gives:
  - the goal and the files involved;
  - the branch and worktree to work in;
  - the project's rules from its context files (`CLAUDE.md`, `.agentcontext` and similar), such as branch naming, commit style and any attribution rule;
  - when the task counts as done;
  - what to report back.

  The SubagentStart hook gives every agent the user's rules file, so a brief doesn't need to repeat those rules. It still has to carry the project's own.
- Review each result. If it's wrong or incomplete, send it back to the same agent with `SendMessage`, which keeps its context, or dispatch a fix. Don't patch it yourself.
- Merge one branch at a time and run the project's tests after each merge, as a background command. If a merge conflicts in more than a line or two, dispatch an agent to resolve it.
- Agents inherit the session's model and effort: leave out `model` and `effort` on Agent calls unless the user names one.
- Use as few agents as the work needs.

Reading files to plan or review is fine.

When `cloud.on` is true in the state file, read `${CLAUDE_SKILL_DIR}/cloud.md` before the first dispatch. It says which tasks go to cloud agents, how to dispatch them, and how their work comes back. It also covers the pushes that cloud mode allows without asking: task branches and draft releases, never `main`.

## Keep working while a question is open

An `AskUserQuestion` pauses your turn until it's answered or times out. Background agents and background commands keep running meanwhile.

- Before asking, start any work that doesn't depend on the answer in the background.
- If you have a sensible default, don't block on `AskUserQuestion`. Ask in plain text, say which default you're going with, and keep working. The user's reply arrives mid-turn, and you adjust when it does.

## Changing the setup mid-session

- The user asks to switch ("go multi-agent", "switch to single-agent"): update `workflow` in the state file and say the new setup in one line. Don't ask again.
- The user asks to turn autonomous mode on or off: if the state file shows it already in that state, say so. Otherwise invoke `session-kit:autonomous-mode`, which updates the state file.
- The user asks to turn cloud agents on or off ("turn cloud agents on", "turn cloud agents off"): set `cloud.on` in the state file and say the new setup in one line. Turning it on writes `{ "on": true, "remote": "unknown" }`, so the next cloud task checks again whether cloud subagents are available.
- The user types `/start` (or `/session-kit:start`): if it comes with a setup ("/start multi-agent", "/start cloud on", "/start cloud off"), apply that. Otherwise ask the three questions again. Apply only what changed: invoke `session-kit:autonomous-mode` only when the answer differs from what the state file says, since each invocation flips it.

## After a resume, a fork or a summary of the chat

The hook restates the saved setup. Keep working with it: don't ask the questions again, and don't toggle autonomous mode because of the note. If the hook says no setup was saved but the conversation shows one (after a fork, for example), write that setup to this session's state file without asking, `cloud` included, with `remote` as the conversation last showed it.

When cloud is on, the hook also prints `Cloud agent rules: <path> (read it before dispatching).` A summary of the chat drops what you read before, so read that file again before the next dispatch. Keep `cloud.remote` as the state file has it: `"unavailable"` means later tasks run locally without a new check.
