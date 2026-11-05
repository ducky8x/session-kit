# Discord: guided setup

This file is part of the `session-kit:discord` skill, which sends you here to set Discord up. SKILL.md has what these steps refer to: the plugin version, the status codes, and what to do once setup is done.

The session never asks for, sees, handles or types the bot token. The user gives it only to `sk-discord setup token` in their own terminal, by pasting it at the hidden prompt or piping it from the clipboard, never to the chat (step 3).

Run the steps in order, one at a time. After each step, stop and wait for the user to say it's done before you start the next one. Skip a step only when its result is already in place (the binary exists, `status` no longer says `no-token`, and so on). These steps need the user's hands, so they wait for the user even in autonomous mode. If the user stops partway, say which step is next and that `/discord on` picks it up later.

## 1. Install the helper

Find the file and its size first, and tell the user the file name, where it comes from and how big it is. Download only after the user agrees.

```bash
v="<version>"  # put the plugin's version here ("Plugin version" in SKILL.md)
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then arch=arm64; else arch=x64; fi
url="https://github.com/ducky8x/session-kit/releases/download/v$v/sk-discord-darwin-$arch"
echo "$url"
curl -sIL "$url" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength: *//p' | tail -n 1
```

The last line is the size in bytes; give it in MB. If the release isn't found, say that the helper for version `v<version>` isn't published yet, and stop the setup.

After the user agrees, download it with its checksums, check the hash, and install it:

```bash
v="<version>"  # put the plugin's version here ("Plugin version" in SKILL.md)
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then arch=arm64; else arch=x64; fi
base="https://github.com/ducky8x/session-kit/releases/download/v$v"
file="sk-discord-darwin-$arch"
dir="$HOME/.claude/session-kit/bin"
mkdir -p "$dir" &&
  curl -fsSL -o "$dir/sk-discord.new" "$base/$file" &&
  curl -fsSL -o "$dir/checksums.txt" "$base/checksums.txt" &&
  want=$(grep -F "$file" "$dir/checksums.txt" | head -n 1 | cut -d ' ' -f 1) &&
  have=$(shasum -a 256 "$dir/sk-discord.new" | cut -d ' ' -f 1) &&
  [ -n "$want" ] && [ "$want" = "$have" ] &&
  chmod 755 "$dir/sk-discord.new" &&
  mv "$dir/sk-discord.new" "$dir/sk-discord" &&
  "$dir/sk-discord" --version
ok=$?
rm -f "$dir/sk-discord.new" "$dir/checksums.txt"
[ "$ok" -eq 0 ]
```

If it fails, nothing was installed; say whether the download or the checksum failed. The binary is signed ad hoc, not notarized. A Mac managed by an organization may still block it; if it won't run, say so and stop.

When the helper was installed before and only the binary went missing, the later steps may still be in place. Run `status` after installing and go by "Status codes" in SKILL.md; if it says the helper isn't running and `config.json` already names a server (`guildId`), go on with step 6.

## 2. Server and bot

The user does this in Discord and in the developer portal:

1. Create a private server, or pick one they own that has no other members. Tell them to keep it to themselves: anyone else in the server can read every session's posts.
2. At https://discord.com/developers/applications, create an application, open its Bot page and turn on **Message Content Intent** (under Privileged Gateway Intents). Without it the bot can't read what they type.
3. Keep the portal open: step 3 needs the bot's token from the Bot page, and step 4 needs the Application ID from the General Information page.

## 3. The bot token

The session never asks for, sees, handles or types the bot token. The user puts it into the helper themselves:

- Tell them to open their own terminal (Terminal, iTerm or similar, outside this session), run `~/.claude/session-kit/bin/sk-discord setup token`, and paste the token there. Input is hidden, and the helper stores it in the macOS Keychain. The token comes from the portal's Bot page (**Reset Token** shows a new one).
- If pasting at the hidden prompt doesn't save the token, give them the other way in. They copy the token from the portal's Bot page again, then run these two commands in their own terminal. The first pipes the clipboard into the helper without showing it, and the second clears the clipboard. The helper's error message gives the same two commands when a pasted token fails its check.

  ```bash
  pbpaste | ~/.claude/session-kit/bin/sk-discord setup token
  pbcopy < /dev/null
  ```

- Tell them never to paste the token into this chat.
- Don't run `setup token` yourself in any form, the `pbpaste` one included: not with the Bash tool, not in a terminal tab you open, not any other way.
- If the user pastes a token into the chat anyway, don't use it and don't repeat it. Tell them it's now in the conversation's transcript, so they should reset it in the portal and run `setup token` with the new one.

When they say it's done, run `~/.claude/session-kit/bin/sk-discord status`. If it still says `no-token`, the token wasn't saved; ask them to run the command again, or to use the `pbpaste` way above if pasting at the prompt failed.

## 4. Invite the bot

Ask the user for the Application ID from the portal's General Information page. It's a public number, not a secret. Run `~/.claude/session-kit/bin/sk-discord setup invite --app-id <id>` and show the link it prints. The user opens it, picks their server and authorizes the bot.

## 5. Pick the server

Run `~/.claude/session-kit/bin/sk-discord setup server`. It lists the servers the bot is in.

- With one server, it picks that one. With more, ask the user which one (`AskUserQuestion`, with the server names as options) and give the choice to `setup server` the way its output says.
- The owner, the only person whose messages the bot reads, is the server's owner. Show the user the owner's name the command prints and ask them to confirm it's their account. If it isn't, stop: the server has to be one they own.
- It creates the categories Desktop, VS Code, CLI and Archive and the `#session-kit` channel, and posts a welcome there.

## 6. Start the helper

Run `~/.claude/session-kit/bin/sk-discord setup launch-agent`. It installs the LaunchAgent that starts the helper at login and starts it now. Then run `status`, waiting a few seconds between tries, until it shows `connected`. If it shows `off`, the helper is running but Discord isn't switched on yet: run `sk-discord on` (step 8's switch) and check again. For any other code, follow "Status codes" in SKILL.md.

## 7. Notifications

Tell the user, in these words: "Keep Discord notifications on. Set this server to All Messages (server name > Notification Settings) so every post reaches you; the bot @mentions you only when a session is waiting on you." The welcome post in `#session-kit` says the same.

Then tell them two more things:

- While a question dialog is open in a session, that session can't act on an answer from Discord until the dialog closes. With `askUserQuestionTimeout` set in their Claude Code settings, the dialog closes by itself after that time; without it, an answer from Discord waits until someone is at the keyboard.
- Keep the server to themselves: anyone added to it can read every post.

## 8. Turn it on

Run `~/.claude/session-kit/bin/sk-discord on` if step 6 didn't already, so `config.json` has `"enabled": true`. Read `config.json`; if `offered` isn't `true`, set it to `true` with the Edit tool and change nothing else. Then say Discord is set up, and connect this session as "After setup" in SKILL.md says.
