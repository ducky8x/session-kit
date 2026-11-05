# Changelog

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
