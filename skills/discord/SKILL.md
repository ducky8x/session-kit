---
name: discord
description: Connect this session to Discord through session-kit's helper, sk-discord. The user's own private server gets a channel per session; the session posts there when work finishes or needs the user, and what the user types in the channel reaches the session. Use for /discord on, /discord off, /discord status and /discord update; when the startup question "Set up Discord now?" is answered Yes; when the session-start hook says Discord is turned on but not installed; when the hook prints a Discord channel and a listener command; and when a Discord listener event arrives. macOS only.
---

# Discord

session-kit's Discord helper, `sk-discord`, runs in the background on the user's Mac. It holds one bot in the user's own private Discord server and gives every interactive session a text channel, in a category for its surface (Desktop, VS Code or CLI). The session posts in its channel, and what the user types in that channel comes back to the session. Channels that stay quiet for a week move to Archive; after a month they're deleted.

- The helper is `~/.claude/session-kit/bin/sk-discord`. Its settings are in `~/.claude/session-kit/discord/config.json` (`enabled` and `offered`, among others), and its log is `helper.log` in the same folder.
- This session's id is `${CLAUDE_SESSION_ID}`. If that shows a placeholder instead of an id, use the `Session id:` line from the session-start hook. Commands below write it as `<id>`.
- Plugin version: the helper follows it, and setup and updates install that version. Read it with:

  ```bash
  sed -n -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" | head -n 1
  ```

- The helper is macOS-only for now. On any other system, say so in one line for every `/discord` command and change nothing.
- The full name of the command is `/session-kit:discord`; `/discord` works too when no other skill uses that name.

## Commands

When the user typed a `/discord` command, run it; with no argument, treat it as `/discord status`. When this skill was loaded for another reason, go by that reason:

- The startup question "Set up Discord now?" was answered Yes, or the session-start hook said Discord is turned on but not installed: run `/discord on`.
- The session-start hook printed a Discord channel and a listener command, or a listener event arrived: follow "In every session with Discord on".

### /discord on

1. Not macOS (`uname -s` isn't `Darwin`): say "The Discord helper is macOS-only for now." and stop.
2. If `~/.claude/session-kit/bin/sk-discord` doesn't exist, start the guided setup at step 1.
3. Otherwise run `~/.claude/session-kit/bin/sk-discord on`, then `~/.claude/session-kit/bin/sk-discord status`.
   - `connected`: make sure `config.json` has `"offered": true` (if not, set it with the Edit tool and change nothing else), say Discord is on, and connect this session (see "After setup").
   - Any other code: pick up the guided setup at the step that fixes it (see "Status codes"), and carry on from there to the end.

### /discord off

- With the helper installed, run `~/.claude/session-kit/bin/sk-discord off`. The helper disconnects but keeps running, so `status` and `on` still work.
- Without it, set `"enabled": false` and `"offered": true` in `config.json`. If the file exists, change only those two fields with the Edit tool. If it doesn't, create it:

  ```bash
  mkdir -p ~/.claude/session-kit/discord && chmod 700 ~/.claude/session-kit/discord
  [ -e ~/.claude/session-kit/discord/config.json ] || printf '{"offered":true,"enabled":false}\n' > ~/.claude/session-kit/discord/config.json
  ```

- Stop this session's listener if one is running (`TaskStop` on its background task), and post nothing more.
- Tell the user: no new channels or posts from now on, existing channels stay and age out, and `/discord on` turns it back on without redoing the setup.

### /discord status

Run `~/.claude/session-kit/bin/sk-discord status` and give the user its code and fix in a line or two. Without the helper, the code is `not-installed` and the fix is `/discord on`.

### /discord update

The helper follows the plugin's version: the session-start hook starts an update by itself when they differ. This command does the same on demand.

1. Without the helper, run the guided setup from step 1 instead.
2. Read the plugin's version (see "Plugin version" above).
3. Tell the user which version you're installing, then run `~/.claude/session-kit/bin/sk-discord update --version <version>`. It downloads the release, checks its SHA-256 against the release's `checksums.txt`, swaps the binary and restarts the helper.
4. Run `status`. If it says `update-failed`, the old helper is still in place; say so, and offer to reinstall with step 1 of the guided setup.

## Status codes

| Code | Meaning | What to do |
| :- | :- | :- |
| `connected` | Working | Nothing |
| `off` | Turned off with `/discord off` | `sk-discord on` |
| `not-installed` | No helper binary | Setup step 1 |
| `no-token` | No bot token in the Keychain | Setup step 3 |
| `token-rejected` | Discord refused the token | Setup step 3, with a new token from the portal |
| `intent-missing` | Message Content Intent is off | Setup step 2, the intent toggle only |
| `not-in-server` | The bot isn't in the server | Setup steps 4 and 5 |
| `update-failed` | The last update didn't install | `/discord update`, or setup step 1 |

If `status` says the helper isn't running, go to setup step 6. When `status` prints its own fix, follow that.

## Guided setup

To set up, or to finish a setup that stopped partway, read `${CLAUDE_SKILL_DIR}/setup.md` with the Read tool and follow it. It has eight steps, run one at a time, waiting for the user after each; "Setup step" in the table above means a step there.

The session never asks for, sees, handles or types the bot token. The user pastes it only into `sk-discord setup token` in their own terminal, never into the chat. If a token shows up in the chat anyway, don't use it or repeat it, and tell the user to reset it in the developer portal.

## After setup

This session started before Discord was on, so it has no channel yet. Its first post creates one: send a short line, such as `~/.claude/session-kit/bin/sk-discord send --session <id> "Connected to Discord."`, then start the listener (see "The listener"). New sessions get their channel by themselves.

## In every session with Discord on

These rules hold in the main session for as long as Discord is on. A subagent doesn't listen or post.

### The listener

When the session-start hook prints `Discord: #<channel> (<category>)` with a listener command, start the listener before other work:

- Run `~/.claude/session-kit/bin/sk-discord listen --session <id>` as a background command (the Bash tool with `run_in_background`). Don't use Monitor: it expires after 30 minutes at most, and every expiry costs a turn.
- The listener waits for one event, prints it as one JSON line and exits, so an idle session costs nothing. When its output arrives, handle the event, then start the listener again.
- Start it again after every event except `disabled`, `unlinked` and `replaced`. Keep exactly one running: after a summary of the chat, the one you started earlier may still be running, so check your background tasks first. If two do run, the helper keeps the newer one and ends the older one with `replaced`.
- Don't poll. Events come to you.
- Events that arrived while nothing was listening come with `"queued": true`. Handle them in order, like any other event.

### When to post

Post with `~/.claude/session-kit/bin/sk-discord send --session <id> "<text>"`. For longer text or text with quotes, pass `-` and give the text on stdin with a heredoc.

- Post when a task finishes, when something fails or you're stuck, and when a long run ends. Never post frequent progress updates.
- Add `--done` to the last post of a finished task. That stops the hourly check-ins.
- Add `--ping` only when you're blocked until the user answers. The hooks already @mention the user for permission prompts, input dialogs and questions left unanswered at the keyboard, so don't ping for those.
- Lead with the result and keep it short. The helper splits posts over 2,000 characters, so send the whole text; nothing is cut.
- Never post tokens, passwords, keys or file contents. Code only as a short snippet.

Exit codes from `send`: 0 posted or queued; 1 an error; 2 the helper isn't running; 3 Discord is off; 4 the session isn't linked. On 3, stop posting and listening. On 1, 2 or 4, tell the user at the keyboard in one line, once, and carry on with the work.

### Questions

Questions reach Discord on their own: a hook records each `AskUserQuestion`, and if nobody answers at the keyboard within 2 minutes, the helper posts it with an @mention. Don't post questions yourself, and ask at the keyboard as usual.

While the dialog is open, a Discord answer waits until it closes. If the dialog closes unanswered, the question stays open on Discord. For that question, this replaces the start skill's rule that an unanswered question means working autonomously and asking nothing more: keep working on whatever doesn't need the answer, end the turn if nothing is left, and wait for an `answer` or `autonomous` event.

### Events

Each line from the listener is JSON with a `type`:

- `text` (`id`, `text`, `at`): the user typed this in the session's channel. Treat it like something they typed at the keyboard. Reply in the channel with `send`, since they're probably away, and at the keyboard as usual.
- `stop`: the user typed `stop`, and the helper replied "Stopping." Stop now: don't start another step, and leave files as they are. Say in one line, at the keyboard and with `send`, that you stopped and where you left off. Then listen for the next message.
- `pause`: the helper replied "Pausing after this step." Finish the step you're in, don't begin the next one, say in one line (keyboard and `send`) that you're paused, and wait. Carry on when `resume` arrives or the user asks for something new.
- `resume`: the helper replied "Resuming." Pick up where you paused, and say so in one line.
- `answer`: the user answered an open question in Discord. `answers` lists `{number, letter, option}`; `raw` is what they wrote, passed through when it isn't in the `1a 2b` form, so read it yourself; `missing` lists the questions they skipped, so take that question's default or decide. An `answer` wins over the keyboard dialog: when the dialog later returns a result, ignore it. With `"late": true`, it came after the defaults were taken at the hour mark: adjust only if it still matters, and say what changed.
- `reminder`: 30 minutes without an answer; the helper pinged the user again. Nothing to do: keep working on what doesn't need the answer.
- `autonomous`: an hour without an answer. The event lists the defaults the helper took. Use them, turn on autonomous mode (invoke `session-kit:autonomous-mode`, unless the state file shows it's already on), and keep going. List those defaults under "Decisions I made".
- `checkin`: the helper posted its hourly check-in. These continue until a post with `--done`. You may add one short status line with `send`; nothing else is needed.
- `disabled`: Discord was turned off. Stop listening and posting, don't start the listener again, and say so in one line at the keyboard.
- `unlinked`: this session's channel is gone (deleted by hand, or removed after a month without messages). Don't start the listener again now. A later post creates a new channel; start the listener again after that post.
- `replaced`: a newer listener for this session took over, for example one started after a summary of the chat. Don't start the listener again; the newer one is already running.
- `helper-down` (the listener exits with code 2): the helper isn't running. Start the listener once more. If it's down again, tell the user at the keyboard, with the fix `launchctl kickstart -k gui/$UID/io.github.ducky8x.session-kit.discord`, and start the listener again when they say it's back or `status` shows `connected`.

### Messages that arrive between listeners

- A Stop hook message that starts `Discord message(s) for this session:` carries messages that arrived while no listener ran. Handle them like `text` events, then start the listener.
- A session can be woken by a Discord message. A closed terminal session is resumed in the background, and its first message says it was woken by a Discord message and gives the text. Start the listener first, then handle the message, and reply with `send`. A woken session keeps the permission mode it had, so a step that needs a permission prompt may wait with nobody there; if you see one coming, say so in a short post and take another route.
- Desktop and VS Code sessions can't be woken: their messages wait until the session is opened again and arrive as queued events.

### What the user can type

In a session's channel, `stop`, `pause`, `resume` and `status` (the whole message, any case) are control words; everything else comes to the session as text. In `#session-kit`, `status` lists every linked session. The bot reads only the server owner's messages.
