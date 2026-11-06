# session-kit

session-kit is a Claude Code plugin that sets up every session the same way. When a session starts, it asks whether one agent should do the work or coordinate worker agents, whether the session should run autonomously, and whether worker agents can run in the cloud. It also loads your standing rules into every session and subagent, and keeps a short per-project brief that new sessions read first. For a bigger task, it can work out a detailed spec with you and build it once you say go.

## Install

From GitHub, run these in a Claude Code session:

```text
/plugin marketplace add ducky8x/session-kit
/plugin install session-kit@session-kit
```

The install command opens the plugin's details in the `/plugin` panel, where you choose a scope and install. From your shell, `claude plugin marketplace add ducky8x/session-kit` and then `claude plugin install session-kit@session-kit` do the same.

From a local clone, add the clone's folder as the marketplace. Run this from the folder that holds the clone, or give an absolute path. A relative path has to start with `./` or `../`, because Claude Code reads a bare `name/name` as a GitHub repository:

```text
/plugin marketplace add ./session-kit
/plugin install session-kit@session-kit
```

A marketplace added from a local folder reads the plugin's files in place, so edits in the clone apply at the next session start or after `/reload-plugins`.

The setup questions come from a SessionStart hook, so after you install they first appear in your next new session or after `/clear`.

To try the plugin for one session without installing it, start Claude Code with `--plugin-dir`:

```bash
claude --plugin-dir ./session-kit
```

## What happens when a session starts

1. The SessionStart hook gives Claude the session id, the path of the session's state file and your rules file, and asks it to run `/session-kit:start` before anything else.
2. The start skill asks up to four questions in one dialog:
   - **Workflow**: Single-agent (one agent does all the work) or Multi-agent (this agent plans, hands tasks to worker agents, reviews their results, and handles the repo and git).
   - **Autonomous**: No (Claude asks when a decision is yours) or Yes (Claude decides, notes each assumption, and keeps going).
   - **Cloud**: No (worker agents run on your computer) or Yes (in a multi-agent session, worker tasks that don't need your computer run as cloud subagents once Claude Code offers them, and on your computer until then). See [Cloud agents](#cloud-agents).
   - **Discord**, asked on macOS until you set Discord up or turn it down: Yes (Claude walks you through setting up a private Discord server with a channel for each session) or No (you can turn it on later with `/discord on`). See [Discord](#discord).

   It skips what your first message already answers, and it doesn't ask in subagents or in print mode (`claude -p`). If you set `askUserQuestionTimeout` and nobody answers in time, it picks single-agent, autonomous mode on and cloud agents off, and it asks about Discord again in the next session.
3. It saves the answers in the session's state file and prints one line, such as `Workflow: multi-agent · Autonomous: ON · Cloud agents: ON`.
4. If a `.agentcontext` file exists in the current folder or a parent folder, it runs `/session-kit:load-context`. Then it starts on your request.

After a summary of the chat (compaction), a resume or a fork, the hook restates the saved setup instead of asking again. To change the setup mid-session, run `/session-kit:start` or say something like "switch to single-agent".

## Skills

| Command | What it does |
| :- | :- |
| `/session-kit:start` | Sets the session's workflow, autonomous mode and [cloud agents](#cloud-agents). Runs by itself at session start; run it again to change the setup. It also creates your rules file from the template when you ask. |
| `/session-kit:autonomous-mode` | Turns autonomous mode on or off. Followed by a task, it turns it on for that task only. While it's on, Claude decides instead of asking, still stops for irreversible steps, lists the decisions it made, and keeps a Mac awake. |
| `/session-kit:load-context` | Reads every `.agentcontext` file in the current folder and its parents, plus the README each one points to. |
| `/session-kit:create-context` | Writes a `.agentcontext` brief for the current project and keeps it out of git. |
| `/session-kit:update-context` | Updates `.agentcontext` with what the session finished and what's left, and prunes stale lines. |
| `/session-kit:brainstorm` | Plans a task with you before building it. Claude researches the project, asks rounds of questions, writes a spec to `.task/<name>.md`, and starts building only when you say go. |
| `/session-kit:discord` | Connects your sessions to Discord (macOS only). `on` sets it up or turns it back on, `off` turns it off, `status` says what's wrong if it isn't working, and `update` reinstalls the helper. See [Discord](#discord). |

Claude also runs these skills on its own when a request matches, such as "go autonomous" or "catch me up".

Each skill also answers to its bare name, such as `/start`, as long as no other skill or command uses that name. Claude Code has no built-in `/start`. If you have a personal skill with the same name, the bare name runs yours, and the `/session-kit:` name runs the plugin's. The superpowers plugin's skill is named `brainstorming`, so bare `/brainstorm` doesn't collide with it.

## Task specs

Ask Claude to brainstorm, plan or spec out a task ("let's brainstorm the export feature", or `/session-kit:brainstorm` followed by the task), and it writes a spec before building anything. Each task gets one file, `.task/<name>.md`, in the current folder. Inside a git repo, the skill adds `.task/` to the clone's private exclude file unless git already ignores it, so specs stay out of your commits.

1. Claude reads the code, the docs and `.agentcontext` first, so it doesn't ask what the project already answers.
2. It splits the task into parts and drafts the spec.
3. It asks rounds of questions, up to four at a time, each with a default, until every part is covered in the same detail: what it does, inputs and outputs, edge cases, how it's built and how it's verified.
4. It asks whether you want to read the full spec or a short summary in chat, then asks for a go-ahead or what to change.
5. On your go, it works through the spec's plan, ticks off each step, and notes in the spec anything it had to do differently.

The questions and the go-ahead run even when autonomous mode is on. Autonomous mode applies to the work after the go. If a round of questions goes unanswered, Claude takes the defaults, marks them as unanswered in the spec's Decisions log, and finishes the spec, but it still waits for your go before building anything.

Each spec has a status (drafting, awaiting go-ahead, approved, in progress, done). When `/session-kit:load-context` briefs you on a project, it names the specs that aren't done yet.

## Cloud agents

The **Cloud** startup question decides whether worker agents can run in the cloud. It only matters in a multi-agent session: a single-agent session saves the answer but sends nothing to the cloud.

With Cloud on, every worker task that doesn't need your computer goes to a cloud subagent, however long it is. Each dispatch line says where the task went, such as "Dispatched fix/parser-crash (cloud)". A task stays on your computer when it:

1. runs macOS-only tools, such as `xcodebuild`, `codesign`, `osascript` or `defaults`;
2. builds, launches or tests a macOS or iOS app, or uses the iOS Simulator;
3. reads or writes anything outside the repo, such as `~/.claude` or `~/Downloads`, or your real data, settings or apps;
4. can't be pushed, because the repo has no GitHub remote or you said not to push it;
5. needs the screen, a browser pane, computer use, hardware, or a local server you're watching;
6. needs secrets kept on your computer, such as the Keychain or a `.env` file that isn't in git;
7. runs one command longer than about 9 minutes that can't save checkpoints and resume;
8. would produce a single output file over 2 GB, the GitHub release asset limit.

If Claude isn't sure, the task stays local.

Claude Code doesn't document cloud subagents yet, and until it offers them, a task sent to the cloud runs on your computer. So the first cloud task in each session checks where it ran. If it ran locally, Claude says so once, merges its work as usual, and runs every later task in that session locally. The same happens if a cloud task can't push to the repo. From then on, the setup restated after a summary of the chat or a resume shows `Cloud agents: ON (running locally: not available)`. The next session checks again.

Turning Cloud on lets Claude push to your GitHub repo without asking, in two cases:

- **Task branches.** Each cloud task gets its own branch, made from your local `main`. Claude pushes the branch before dispatching the task, the cloud agent pushes its commits to it, and Claude deletes it from GitHub after the merge. If your `main` has commits you haven't pushed, they go up on the task branch.
- **Draft releases for files over 50 MB.** A cloud task commits smaller files and uploads bigger ones to a draft GitHub release. Claude downloads them, checks their SHA-256 hashes, and deletes the release once they match.

Cloud mode never pushes `main`, and every other push still waits for your OK.

A cloud machine runs one command for at most 10 minutes, and it pauses after a few minutes without activity. So a command expected to run longer than about 9 minutes goes to the cloud only if it can save checkpoints and resume. The cloud agent then runs it in 9-minute chunks, each starting from the last checkpoint, and commits small outputs such as metrics and logs after each chunk.

To switch mid-session, say "turn cloud agents on" or "turn cloud agents off", or run `/session-kit:start cloud on` or `/session-kit:start cloud off`.

## Discord

session-kit can give every interactive session its own channel in a private Discord server of yours. A small helper, `sk-discord`, runs in the background and keeps one bot in that server.

- Each channel is named after its session, with a suffix for where the session runs: `-desktop` (the Claude desktop app), `-vs` (VS Code) or `-cli` (the terminal).
- A session's channel appears with its first prompt or post, so a session you never use gets none. One chat keeps one channel: after `/clear`, or when you move a chat to the background, the channel goes with it.
- A session posts in its channel when work finishes, fails or needs you. What you type in the channel reaches that session; `stop`, `pause`, `resume` and `status` work as commands.
- A channel with no messages for 7 days moves to an Archive category. After 30 days without messages it's deleted.

The helper runs only on macOS.

To turn it on, answer Yes when your first session after installing session-kit asks "Set up Discord now?", or run `/discord on` later. Claude takes you through the setup one step at a time: it installs the helper from this repository's GitHub releases, and you create the server and the bot. You paste the bot token only into `sk-discord setup token` in your own terminal, never into the chat. Claude never sees it, and the helper keeps it in the macOS Keychain.

Keep Discord notifications on, and set the server to All Messages (server name > Notification Settings). The bot @mentions you only when a session is waiting on you, such as for a permission prompt or a question nobody answered at the keyboard. Keep the server to yourself: anyone else in it can read every post.

On battery power the helper keeps no live connection to Discord. It checks for new messages every 5 minutes instead, so what you type in a channel can take up to 5 minutes to reach the session; posts from sessions still go out at once. When the Mac is back on AC power, it reconnects and picks up anything sent since the last check. To check more or less often, set `batteryPollMinutes` in `~/.claude/session-kit/discord/config.json` (at least 1), then run `/discord on`.

`/discord status` shows whether the helper is connected and what to fix if it isn't. `/discord off` stops new channels and posts but keeps the setup, so `/discord on` turns it back on. After a plugin update, the session-start hook updates the helper to the plugin's version by itself.

The helper is `~/.claude/session-kit/bin/sk-discord`. Its settings, session list and log are in `~/.claude/session-kit/discord/`, and a LaunchAgent, `~/Library/LaunchAgents/io.github.ducky8x.session-kit.discord.plist`, starts it at login.

## Your rules file

Put your standing rules in `~/.claude/session-kit/rules.md`: how to address you, git conventions, writing style, things never to do. The hooks load the file into the session at startup, after `/clear`, after a summary of the chat and on resume, and into every subagent.

Keep it under 8000 bytes. A file of up to 8000 bytes loads in full. A bigger one gets only a note telling Claude to read it, because Claude Code cuts hook output over 10,000 characters down to a short preview.

To start one, ask Claude to create your session-kit rules file, and the start skill copies the template for you. Or copy it yourself from the root of a clone:

```bash
mkdir -p ~/.claude/session-kit
cp -n skills/start/rules-template.md ~/.claude/session-kit/rules.md
```

The file is yours. The plugin never overwrites it: the start skill copies the template only when no rules file exists.

## Where state lives

Each session's setup is saved in `~/.claude/session-kit/state/<session id>.json`: the workflow, whether autonomous mode is on and for what scope, the ids of its keep-awake command and heartbeat, and the Cloud answer with whether cloud subagents turned out to be available. That file lets the setup survive a summary of the chat. The session-start hook deletes state files older than 30 days.

## Requirements

- bash and standard tools (`sed`, `awk`, `find`, `tr`, `wc`). The hooks don't need python3 or jq. On Windows, the hooks need Git Bash.
- Keep-awake in autonomous mode uses `caffeinate`, so it only works on macOS. On other systems autonomous mode runs without it and says so.

## Running the tests

```bash
bash tests/test-hooks.sh
```

The tests run each hook with a temporary `HOME`, so they never touch your real `~/.claude`. They use python3 to check the JSON the subagent hook prints.

## If you already have your own versions

- **Skills with the same names** in `~/.claude/skills` (`start`, `autonomous-mode`, `load-context`, `create-context`, `update-context`, `brainstorm`, `discord`): remove or rename them. Otherwise both copies load, Claude sees two skills for the same job, and the bare `/name` runs your copy.
- **SessionStart or SubagentStart hooks** in `~/.claude/settings.json` that ask setup questions or inject a rules file: remove them. Plugin hooks run alongside the hooks in your settings, so you'd get both. Move your rules into `~/.claude/session-kit/rules.md`.

## Reporting issues

Report bugs and other problems on the [GitHub issues page](https://github.com/ducky8x/session-kit/issues).

## License

MIT. See [LICENSE](LICENSE).
