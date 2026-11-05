# Changelog

## 0.2.0 - 2026-11-05

Discord companion: every interactive session can get its own channel in a private Discord server of yours. macOS only.

### Discord helper

- `sk-discord`, a background helper compiled with Bun into one binary for Apple silicon and Intel Macs and started at login by a LaunchAgent. It holds the bot's connection to Discord, keeps the session list and the posts made while offline, and reads the bot token from the macOS Keychain.
- A channel per interactive session, in a Desktop, VS Code or CLI category, named after the session with a `-desktop`, `-vs` or `-cli` suffix and renamed once the session has a name. The channel appears at the session's first prompt or post, so sessions that never start a chat get none, and a chat that's cleared or moved to the background keeps its channel. A channel moves to Archive after 7 days without messages and is deleted after 30.
- `sk-discord send` posts from a session. Permission prompts, input dialogs and questions nobody answers at the keyboard post with an @mention.
- What you type in a session's channel reaches that session: at once while it listens, at the end of its turn while it's busy, by waking it when it's a closed terminal session, and when it's opened again for a closed desktop or VS Code session. `stop`, `pause`, `resume` and `status` work as commands.
- A question left unanswered at the keyboard for 2 minutes goes to Discord, with a reminder at 30 minutes, the defaults taken at an hour, and hourly check-ins after that. Typing at the keyboard, or pressing Esc on the question, keeps it off Discord.

### Skills

- `discord`: `/discord on`, `off`, `status` and `update`, a guided setup that runs one step at a time, and the rules sessions follow to listen and post. You paste the bot token only into `sk-discord setup token` in your own terminal, or pipe it in with `pbpaste` when pasting at the hidden prompt doesn't work.
- `start`: offers the Discord setup once, in the first session after installing session-kit, as a third startup question.

### Hooks

- SessionStart also runs `hooks/discord.sh`, which registers the session with the helper, prints its listener command, and updates the helper when its version differs from the plugin's.
- SessionEnd, Notification (permission prompts and input dialogs), PreToolUse and PostToolUse for AskUserQuestion, UserPromptSubmit, and Stop hooks pass their events to the helper. Without the helper installed, they print nothing.

### Releases

- A release workflow builds and ad hoc signs the helper for each `v*` tag that matches the plugin's version, and publishes `sk-discord-darwin-arm64`, `sk-discord-darwin-x64` and `checksums.txt`. CI also runs the helper's tests on macOS and Linux.

## 0.1.0 - 2026-11-04

First release.

### Skills

- `start`: asks whether the session runs single-agent or multi-agent and whether it runs autonomously, saves the answers, and creates your rules file from a template when you ask.
- `autonomous-mode`: turns autonomous mode on or off for the session, or on for one task. While it's on, Claude decides instead of asking and lists the decisions it made.
- `brainstorm`: plans a task with you in rounds of questions, writes a spec to `.task/<name>.md`, and builds it only after you say go.
- `create-context`: writes a `.agentcontext` brief for the current project and keeps it out of git.
- `update-context`: records in `.agentcontext` what the session finished and what's left, and prunes stale lines.
- `load-context`: reads every `.agentcontext` in the current folder and its parents, plus the README each one points to, and names the task specs that aren't done.

### Hooks

- SessionStart: asks for the start skill in a new session, restates the saved setup after a resume, a fork or a summary of the chat, loads `~/.claude/session-kit/rules.md`, and deletes state files older than 30 days.
- SubagentStart: gives every subagent your rules file and tells it not to run the start skill.
