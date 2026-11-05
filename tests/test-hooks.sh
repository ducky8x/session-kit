#!/usr/bin/env bash
# Tests for the session-kit hooks. Run with: bash tests/test-hooks.sh
# Each test runs a hook with a throwaway HOME and fake stdin JSON, so the
# real ~/.claude is never read or written. Needs python3 to check JSON.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SESSION_START="$ROOT/hooks/session-start.sh"
SUBAGENT_START="$ROOT/hooks/subagent-start.sh"
DISCORD="$ROOT/hooks/discord.sh"
HOOKS_JSON="$ROOT/hooks/hooks.json"

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/session-kit-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP_ROOT"' EXIT

passed=0
failed=0
H=""        # HOME for the current test
OUT=""      # stdout of the last hook run
STATUS=0    # exit status of the last hook run
TEST_LOCALE=C
# The system name the Discord hook sees (its SK_DISCORD_UNAME override).
# Linux by default, so the tests print the same on every system; an empty
# value lets the hook ask uname.
TEST_UNAME=Linux
TEST_PLUGIN_ROOT=""  # CLAUDE_PLUGIN_ROOT for the hooks; empty means unset
TEST_ENTRYPOINT=""   # CLAUDE_CODE_ENTRYPOINT for the hooks

# A UTF-8 locale, to check the hooks under the locale a user usually has.
UTF8_LOCALE=$(locale -a 2>/dev/null | grep -i -x -m 1 -e 'C.UTF-8' -e 'C.utf8' -e 'en_US.UTF-8' -e 'en_US.utf8')

pass() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; return 0; }

new_home() {
  H="$TMP_ROOT/home-$1"
  rm -rf "$H"
  mkdir -p "$H"
}

state_dir() { printf '%s' "$H/.claude/session-kit/state"; }
rules_file() { printf '%s' "$H/.claude/session-kit/rules.md"; }

# run_hook <script> <stdin text> [hook arguments...]
run_hook() {
  local script=$1 input=$2
  shift 2
  OUT=$(printf '%s' "$input" | env -i HOME="$H" PATH="$PATH" LC_ALL="$TEST_LOCALE" \
    SK_DISCORD_UNAME="$TEST_UNAME" CLAUDE_PLUGIN_ROOT="$TEST_PLUGIN_ROOT" \
    CLAUDE_CODE_ENTRYPOINT="$TEST_ENTRYPOINT" "$script" "$@" 2>/dev/null)
  STATUS=$?
}

start_input() { printf '{"session_id":"%s","transcript_path":"/tmp/t.jsonl","cwd":"/tmp","hook_event_name":"SessionStart","source":"%s"}' "$1" "$2"; }
subagent_input() { printf '{"session_id":"%s","cwd":"/tmp","hook_event_name":"SubagentStart","agent_id":"agent-1","agent_type":"Explore"}' "$1"; }

has() { case $OUT in *"$1"*) return 0 ;; *) return 1 ;; esac; }
expect_has() { if has "$2"; then pass "$1"; else fail "$1" "missing: $2"; fi; }
expect_lacks() { if has "$2"; then fail "$1" "unexpected: $2"; else pass "$1"; fi; }
expect_status0() { if [ "$STATUS" -eq 0 ]; then pass "$1"; else fail "$1" "exit status $STATUS"; fi; }
expect_under() { # <name> <limit>
  local n
  n=$(printf '%s' "$OUT" | wc -c | tr -d ' ')
  if [ "$n" -lt "$2" ]; then pass "$1 ($n bytes)"; else fail "$1" "$n bytes, limit $2"; fi
}

# make_file <path> <bytes>: write exactly <bytes> bytes of text lines
make_file() {
  mkdir -p "$(dirname "$1")"
  awk -v n="$2" 'BEGIN { for (i = 0; i < n - 1; i++) printf "%s", (i % 80 == 79 ? "\n" : "x"); printf "\n" }' > "$1"
}

json_valid() { printf '%s' "$OUT" | python3 -c 'import json,sys;json.load(sys.stdin)' 2>/dev/null; }

START_LINE="invoke the session-kit:start skill"
HINT="no rules file yet"
NO_ASK="don't ask the startup questions again"
OFFER_LINE="Discord: not offered yet."
SETUP_LINE="Discord: turned on, but the helper isn't installed."
UPDATE_LINE="Updating the Discord helper to"

echo "== files"
for f in "$SESSION_START" "$SUBAGENT_START" "$DISCORD"; do
  if [ -x "$f" ]; then pass "$(basename "$f") is executable"; else fail "$(basename "$f") is executable"; fi
done
if python3 - "$HOOKS_JSON" <<'PY' 2>/dev/null
import json, sys
hooks = json.load(open(sys.argv[1]))["hooks"]
ss = hooks["SessionStart"][0]
assert set(ss["matcher"].split("|")) >= {"startup", "clear", "compact", "resume"}
assert "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" in ss["hooks"][0]["command"]
assert "${CLAUDE_PLUGIN_ROOT}/hooks/subagent-start.sh" in hooks["SubagentStart"][0]["hooks"][0]["command"]
PY
then pass "hooks.json wires both hooks through CLAUDE_PLUGIN_ROOT"; else fail "hooks.json wires both hooks through CLAUDE_PLUGIN_ROOT"; fi
if python3 - "$HOOKS_JSON" <<'PY' 2>/dev/null
import json, sys
hooks = json.load(open(sys.argv[1]))["hooks"]
want = {
    "SessionEnd": (None, "session-end"),
    "Notification": ("permission_prompt|elicitation_dialog", "notification"),
    "PreToolUse": ("AskUserQuestion", "pre-ask"),
    "PostToolUse": ("AskUserQuestion", "post-ask"),
    "Stop": (None, "stop"),
}
for event, (matcher, arg) in want.items():
    groups = hooks[event]
    assert len(groups) == 1, event
    assert groups[0].get("matcher") == matcher, event
    handler = groups[0]["hooks"][0]
    assert handler["type"] == "command", event
    assert handler["command"] == '"${CLAUDE_PLUGIN_ROOT}/hooks/discord.sh" ' + arg, event
    assert handler["timeout"] == 10, event
PY
then pass "hooks.json wires the Discord events to discord.sh"; else fail "hooks.json wires the Discord events to discord.sh"; fi

echo "== session-start: startup and clear"
new_home startup
run_hook "$SESSION_START" "$(start_input s-one startup)"
expect_status0 "startup exits 0"
expect_has "startup prints the session id" "Session id: s-one"
expect_has "startup prints the state file path" "State file: $(state_dir)/s-one.json"
expect_has "startup asks for the start skill" "$START_LINE"
expect_has "first run with no rules file gives the hint" "$HINT"
expect_lacks "startup restates no setup" "Session setup (restored)"

run_hook "$SESSION_START" "$(start_input s-two clear)"
expect_has "clear asks for the start skill" "$START_LINE"
expect_has "clear prints the session id" "Session id: s-two"

echo "== session-start: rules hint only on first run"
new_home hint
mkdir -p "$(state_dir)"
echo '{"workflow":"single"}' > "$(state_dir)/s-own.json"
run_hook "$SESSION_START" "$(start_input s-own startup)"
expect_has "this session's own state file still counts as first run" "$HINT"
echo '{"workflow":"single"}' > "$(state_dir)/other-session.json"
run_hook "$SESSION_START" "$(start_input s-own startup)"
expect_lacks "another session's state file stops the hint" "$HINT"

echo "== session-start: compact, resume and fork"
new_home restore
mkdir -p "$(state_dir)"
cat > "$(state_dir)/s-multi.json" <<'JSON'
{
  "workflow": "multi",
  "autonomous": {
    "on": true,
    "scope": "session",
    "keepAwakeTaskId": "b1",
    "heartbeatCronId": "c1"
  },
  "updatedAt": "2026-11-04T10:00:00Z"
}
JSON
run_hook "$SESSION_START" "$(start_input s-multi compact)"
expect_status0 "compact exits 0"
expect_has "compact restates the saved setup" "Session setup (restored): Workflow: multi-agent · Autonomous: ON (this session)"
expect_has "compact says not to ask again" "$NO_ASK"
expect_has "compact says not to toggle autonomous mode" "don't toggle autonomous mode"
expect_lacks "compact doesn't ask for the start skill" "$START_LINE"
expect_has "compact prints the session id" "Session id: s-multi"
expect_lacks "compact has no resume-only restart note" "have stopped"

echo '{"workflow":"single","autonomous":{"on":true,"scope":"task","task":"fix the \"build\""},"updatedAt":"x"}' > "$(state_dir)/s-task.json"
run_hook "$SESSION_START" "$(start_input s-task resume)"
expect_has "resume restates a task-scoped setup" 'Workflow: single-agent · Autonomous: ON (until fix the "build" is done)'
expect_lacks "resume doesn't ask for the start skill" "$START_LINE"
expect_has "resume with autonomous on notes stopped background work" "have stopped"

echo '{"workflow":"multi","autonomous":{"on":false},"updatedAt":"x"}' > "$(state_dir)/s-off.json"
run_hook "$SESSION_START" "$(start_input s-off resume)"
expect_has "resume restates autonomous off" "Workflow: multi-agent · Autonomous: OFF"
expect_lacks "resume with autonomous off has no restart note" "have stopped"

run_hook "$SESSION_START" "$(start_input s-none compact)"
expect_lacks "compact without a state file restates nothing" "Session setup (restored)"
expect_lacks "compact without a state file doesn't ask for the start skill" "$START_LINE"
expect_has "compact without a state file says not to ask again" "$NO_ASK"

run_hook "$SESSION_START" "$(start_input s-fork fork)"
expect_lacks "fork doesn't ask for the start skill" "$START_LINE"
expect_has "fork says not to ask again" "$NO_ASK"

echo "== session-start: rules file"
new_home rules
mkdir -p "$(dirname "$(rules_file)")"
printf '# My rules\n\n- Use "double quotes" and C:\\back\\slashes.\n- Caf\xc3\xa9 \xe2\x9c\x93\n' > "$(rules_file)"
rules_text=$(cat "$(rules_file)")
run_hook "$SESSION_START" "$(start_input s-r startup)"
expect_has "a small rules file is included whole" "$rules_text"
expect_lacks "an included rules file gives no hint" "$HINT"
expect_lacks "a small rules file gives no read note" "Read tool"

make_file "$(rules_file)" 8000
rules_text=$(cat "$(rules_file)")
run_hook "$SESSION_START" "$(start_input s-r startup)"
expect_has "a rules file of exactly 8000 bytes is included whole" "$rules_text"
expect_under "startup output with an 8000-byte rules file stays under 10,000" 10000

mkdir -p "$(state_dir)"
echo '{"workflow":"multi","autonomous":{"on":true,"scope":"task","task":"'"$(awk 'BEGIN{for(i=0;i<600;i++)printf "t"}')"'"}}' > "$(state_dir)/s-r.json"
run_hook "$SESSION_START" "$(start_input s-r resume)"
expect_has "resume restates a setup with a long task" "Session setup (restored): Workflow: multi-agent"
expect_has "a long task is cut short in the restated line" "ttt... is done)"
expect_has "resume output still includes the 8000-byte rules file" "$rules_text"
expect_under "resume output with a long task and an 8000-byte rules file stays under 10,000" 10000

make_file "$(rules_file)" 8001
run_hook "$SESSION_START" "$(start_input s-r startup)"
expect_has "a rules file over 8000 bytes gives the read note" "Read tool"
expect_has "the read note gives the file size" "8001 bytes"
expect_has "the read note gives the file path" "$(rules_file)"
expect_lacks "a rules file over 8000 bytes isn't included" "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
expect_under "output with a large rules file stays small" 3000

echo "== session-start: pruning"
new_home prune
mkdir -p "$(state_dir)"
echo '{}' > "$(state_dir)/old-session.json"
echo '{}' > "$(state_dir)/recent-session.json"
echo '{"workflow":"multi"}' > "$(state_dir)/s-old-self.json"
touch -t 202001010000 "$(state_dir)/old-session.json" "$(state_dir)/s-old-self.json"
run_hook "$SESSION_START" "$(start_input s-old-self resume)"
if [ ! -e "$(state_dir)/old-session.json" ]; then pass "state files older than 30 days are pruned"; else fail "state files older than 30 days are pruned"; fi
if [ -e "$(state_dir)/recent-session.json" ]; then pass "recent state files are kept"; else fail "recent state files are kept"; fi
if [ -e "$(state_dir)/s-old-self.json" ]; then pass "the current session's state file is kept"; else fail "the current session's state file is kept"; fi
expect_has "an old state file of the current session is still restated" "Workflow: multi-agent"

echo "== session-start: bad input"
new_home bad
run_hook "$SESSION_START" ""
expect_status0 "empty stdin exits 0"
if [ -z "$OUT" ]; then pass "empty stdin prints nothing"; else fail "empty stdin prints nothing" "$OUT"; fi
run_hook "$SESSION_START" "not json at all {"
expect_status0 "garbage stdin exits 0"
run_hook "$SESSION_START" "$(start_input '../../etc/x' startup)"
expect_status0 "a session id with path characters exits 0"
expect_lacks "a session id with path characters is not used in a path" "State file:"
OUT=$(env -i HOME="$H" PATH="$PATH" "$SESSION_START" </dev/null 2>/dev/null); STATUS=$?
expect_status0 "no stdin at all exits 0"
OUT=$(printf '%s' "$(start_input s-nohome startup)" | env -i PATH="$PATH" "$SESSION_START" 2>/dev/null); STATUS=$?
expect_status0 "unset HOME exits 0"

echo "== subagent-start"
new_home sub
run_hook "$SUBAGENT_START" "$(subagent_input s-sub)"
expect_status0 "subagent-start exits 0 without a rules file"
if json_valid; then pass "output without a rules file is valid JSON"; else fail "output without a rules file is valid JSON" "$OUT"; fi
expect_has "output says it is a subagent" "subagent"
expect_has "output says not to run the start skill" "session-kit:start"
expect_has "output names the event" '"hookEventName":"SubagentStart"'

mkdir -p "$(dirname "$(rules_file)")"
printf '# Rules "quoted"\n\nPath: C:\\Program Files\\dir\\\n\tTabbed line\nCarriage\rreturn\nControl:\001\002\037 end\nUnicode: caf\xc3\xa9 \xe2\x80\x94 na\xc3\xafve \xe2\x9c\x93 \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e\n{"json": "inside"}\n' > "$(rules_file)"
run_hook "$SUBAGENT_START" "$(subagent_input s-sub)"
expect_status0 "subagent-start exits 0 with a tricky rules file"
if json_valid; then pass "output with quotes, backslashes, tabs, control characters and non-ASCII is valid JSON"; else fail "output with quotes, backslashes, tabs, control characters and non-ASCII is valid JSON" "$OUT"; fi
if printf '%s' "$OUT" | python3 -c '
import json, sys
out = json.load(sys.stdin)["hookSpecificOutput"]
rules = open(sys.argv[1], encoding="utf-8", newline="").read()
assert out["hookEventName"] == "SubagentStart"
assert rules in out["additionalContext"], "rules text not found intact"
' "$(rules_file)" 2>/dev/null
then pass "the rules file round-trips intact through the JSON"; else fail "the rules file round-trips intact through the JSON"; fi
expect_under "subagent output stays under 10,000" 10000
if [ -n "$UTF8_LOCALE" ]; then
  TEST_LOCALE=$UTF8_LOCALE
  run_hook "$SUBAGENT_START" "$(subagent_input s-sub)"
  TEST_LOCALE=C
  if printf '%s' "$OUT" | python3 -c '
import json, sys
ctx = json.load(sys.stdin)["hookSpecificOutput"]["additionalContext"]
assert open(sys.argv[1], encoding="utf-8", newline="").read() in ctx
' "$(rules_file)" 2>/dev/null
  then pass "the rules file round-trips intact under $UTF8_LOCALE"; else fail "the rules file round-trips intact under $UTF8_LOCALE"; fi
else
  pass "no UTF-8 locale installed; skipped the UTF-8 locale check"
fi

make_file "$(rules_file)" 8000
run_hook "$SUBAGENT_START" "$(subagent_input s-sub)"
if json_valid; then pass "output with an 8000-byte rules file is valid JSON"; else fail "output with an 8000-byte rules file is valid JSON"; fi
if printf '%s' "$OUT" | python3 -c '
import json, sys
ctx = json.load(sys.stdin)["hookSpecificOutput"]["additionalContext"]
assert open(sys.argv[1], encoding="utf-8", newline="").read() in ctx
assert len(ctx) < 10000, len(ctx)
' "$(rules_file)" 2>/dev/null
then pass "an 8000-byte rules file is included whole and the context stays under 10,000"; else fail "an 8000-byte rules file is included whole and the context stays under 10,000"; fi

make_file "$(rules_file)" 9000
run_hook "$SUBAGENT_START" "$(subagent_input s-sub)"
if json_valid; then pass "output with a large rules file is valid JSON"; else fail "output with a large rules file is valid JSON"; fi
expect_has "a large rules file gives the read note" "Read tool"
expect_has "the read note gives the file size" "9000 bytes"
expect_lacks "a large rules file isn't included" "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

run_hook "$SUBAGENT_START" ""
expect_status0 "subagent-start with empty stdin exits 0"
if [ -z "$OUT" ] || json_valid; then pass "subagent-start with empty stdin prints nothing or valid JSON"; else fail "subagent-start with empty stdin prints nothing or valid JSON" "$OUT"; fi
run_hook "$SUBAGENT_START" "garbage {"
expect_status0 "subagent-start with garbage stdin exits 0"
OUT=$(printf '%s' "$(subagent_input s-sub)" | env -i PATH="$PATH" "$SUBAGENT_START" 2>/dev/null); STATUS=$?
expect_status0 "subagent-start with unset HOME exits 0"
if [ -z "$OUT" ] || json_valid; then pass "subagent-start with unset HOME prints nothing or valid JSON"; else fail "subagent-start with unset HOME prints nothing or valid JSON" "$OUT"; fi

discord_dir() { printf '%s' "$H/.claude/session-kit/discord"; }
fake_bin() { printf '%s' "$H/.claude/session-kit/bin/sk-discord"; }
write_config() { mkdir -p "$(discord_dir)"; printf '%s\n' "$1" > "$(discord_dir)/config.json"; }
event_input() { printf '{"session_id":"s-d","transcript_path":"/tmp/t.jsonl","cwd":"/tmp","hook_event_name":"%s"}' "$1"; }
count_of() { printf '%s' "$OUT" | grep -c -F -e "$1"; }
expect_empty() { if [ -z "$OUT" ]; then pass "$1"; else fail "$1" "printed: $OUT"; fi; }
expect_file_has() { # <name> <file> <text>
  if [ -f "$2" ] && grep -q -F -e "$3" "$2"; then pass "$1"; else fail "$1" "$2 lacks: $3"; fi
}
expect_no_file() { if [ -e "$2" ]; then fail "$1" "$2: $(cat "$2")"; else pass "$1"; fi; }
# wait_for <file>: up to 3 seconds for a file written in the background
wait_for() { local i=0; while [ ! -s "$1" ] && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done; }

# A stand-in for sk-discord. It records each call in $HOME/fake/ and acts on
# files there: version (what --version prints; the plugin's own version at
# first), sleep (hang for 30 seconds), fail (exit 1), output-<event> (what a
# hook call prints) and update-sleep (an update that takes 10 seconds).
install_fake() {
  mkdir -p "$(dirname "$(fake_bin)")" "$H/fake"
  printf '%s\n' "$REPO_VERSION" > "$H/fake/version"
  cat > "$(fake_bin)" <<'SH'
#!/usr/bin/env bash
f="$HOME/fake"
printf '%s\n' "$*" >> "$f/calls"
case ${1:-} in
  --version)
    cat "$f/version"
    ;;
  hook)
    cat > "$f/stdin-$2"
    printf '%s\n' "${CLAUDE_CODE_ENTRYPOINT:-}" > "$f/entrypoint-$2"
    if [ -e "$f/sleep" ]; then printf 'partial output\n'; sleep 30; fi
    if [ -e "$f/fail" ]; then printf 'error output\n'; exit 1; fi
    if [ -f "$f/output-$2" ]; then cat "$f/output-$2"; else printf 'fake %s output\n' "$2"; fi
    ;;
  update)
    printf '%s\n' "$*" >> "$f/updates"
    printf 'updating to %s\n' "${3:-}"
    if [ -e "$f/update-sleep" ]; then sleep 10; fi
    ;;
esac
exit 0
SH
  chmod 755 "$(fake_bin)"
}

# A plugin folder whose plugin.json has version 0.2.0.
PLUGIN_020="$TMP_ROOT/plugin-0.2.0"
mkdir -p "$PLUGIN_020/.claude-plugin"
printf '{\n  "name": "session-kit",\n  "version": "0.2.0"\n}\n' > "$PLUGIN_020/.claude-plugin/plugin.json"
REPO_VERSION=$(sed -n -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$ROOT/.claude-plugin/plugin.json" | head -n 1)

DISCORD_EVENTS="session-start session-end notification pre-ask post-ask stop"

echo "== discord: no helper installed"
new_home dnone
for ev in $DISCORD_EVENTS; do
  run_hook "$DISCORD" "$(event_input "$ev")" "$ev"
  expect_status0 "$ev with no helper exits 0"
  expect_empty "$ev with no helper prints nothing (Linux)"
done
run_hook "$DISCORD" "$(start_input s-d startup)"
expect_status0 "no event name exits 0"
expect_empty "no event name prints nothing"
run_hook "$DISCORD" "$(start_input s-d startup)" bogus
expect_status0 "an unknown event exits 0"
expect_empty "an unknown event prints nothing"
OUT=$(printf '%s' "$(start_input s-d startup)" | env -i PATH="$PATH" SK_DISCORD_UNAME=Darwin "$DISCORD" session-start 2>/dev/null); STATUS=$?
expect_status0 "unset HOME exits 0"
expect_empty "unset HOME prints nothing"
run_hook "$SESSION_START" "$(start_input s-d startup)"
expect_lacks "session-start on Linux with no config doesn't offer Discord" "$OFFER_LINE"

echo "== discord: first-run offer"
TEST_UNAME=Darwin
new_home doffer
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_status0 "first run on macOS exits 0"
expect_has "first run on macOS with no config.json offers Discord" "$OFFER_LINE"
expect_has "the offer names the start question" "Set up Discord now?"
expect_lacks "the offer isn't the set-up line" "$SETUP_LINE"
for ev in session-end notification pre-ask post-ask stop; do
  run_hook "$DISCORD" "$(event_input "$ev")" "$ev"
  expect_empty "$ev prints nothing on a first run on macOS"
done
for src in clear ""; do
  run_hook "$DISCORD" "$(start_input s-d "$src")" session-start
  expect_has "source '$src' offers Discord" "$OFFER_LINE"
done
for src in compact resume fork; do
  run_hook "$DISCORD" "$(start_input s-d "$src")" session-start
  expect_empty "source $src doesn't offer Discord"
done
run_hook "$SESSION_START" "$(start_input s-d startup)"
if [ "$(count_of "$OFFER_LINE")" -eq 1 ]; then pass "session-start prints the offer once"; else fail "session-start prints the offer once" "count: $(count_of "$OFFER_LINE")"; fi
expect_has "session-start still asks for the start skill" "$START_LINE"
make_file "$(rules_file)" 8000
run_hook "$SESSION_START" "$(start_input s-d startup)"
expect_has "the offer follows an 8000-byte rules file" "$OFFER_LINE"
expect_under "startup output with an 8000-byte rules file and the offer stays under 10,000" 10000
if [ -e "$(discord_dir)" ]; then fail "the offer writes nothing" "$(discord_dir) exists"; else pass "the offer writes nothing"; fi

write_config '{"offered":true,"enabled":false}'
for ev in $DISCORD_EVENTS; do
  run_hook "$DISCORD" "$(event_input "$ev")" "$ev"
  expect_empty "$ev prints nothing once offered and declined"
done
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_empty "offered: true, enabled: false prints nothing"
write_config '{
  "offered": true,
  "enabled": false
}'
run_hook "$SESSION_START" "$(start_input s-d startup)"
expect_lacks "a declined offer isn't repeated" "$OFFER_LINE"
expect_lacks "a declined offer gives no set-up line" "$SETUP_LINE"

TEST_UNAME=""
new_home dreal
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
if [ "$(uname -s)" = Darwin ]; then
  expect_has "with no override, uname Darwin offers Discord" "$OFFER_LINE"
else
  expect_empty "with no override, uname $(uname -s) offers nothing"
fi
TEST_UNAME=Darwin

echo "== discord: turned on but not installed"
new_home dsetup
write_config '{
  "enabled": true,
  "offered": true,
  "guildId": "123"
}'
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_status0 "enabled without a helper exits 0"
expect_has "enabled without a helper gives the set-up line" "$SETUP_LINE"
expect_has "the set-up line names the discord skill" "session-kit:discord"
expect_lacks "enabled without a helper doesn't offer" "$OFFER_LINE"
for src in clear resume fork; do
  run_hook "$DISCORD" "$(start_input s-d "$src")" session-start
  expect_has "source $src gives the set-up line" "$SETUP_LINE"
done
run_hook "$DISCORD" "$(start_input s-d compact)" session-start
expect_empty "compact gives no set-up line"
for ev in session-end notification pre-ask post-ask stop; do
  run_hook "$DISCORD" "$(event_input "$ev")" "$ev"
  expect_empty "$ev prints nothing when enabled without a helper"
done
run_hook "$SESSION_START" "$(start_input s-d startup)"
expect_has "session-start passes on the set-up line" "$SETUP_LINE"
mkdir -p "$(dirname "$(fake_bin)")"
printf '#!/bin/sh\necho should not run\n' > "$(fake_bin)"
chmod 644 "$(fake_bin)"
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_has "a helper file that isn't executable counts as not installed" "$SETUP_LINE"
expect_lacks "a helper file that isn't executable isn't run" "should not run"
rm -f "$(fake_bin)"; mkdir -p "$(fake_bin)"
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_has "a folder in the helper's place counts as not installed" "$SETUP_LINE"
TEST_UNAME=Linux
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_empty "enabled without a helper on Linux prints nothing"
TEST_UNAME=Darwin

echo "== discord: helper installed"
new_home dfake
install_fake
write_config '{"enabled":true,"offered":true}'
TEST_ENTRYPOINT=claude-desktop
for ev in $DISCORD_EVENTS; do
  input=$(printf '{\n  "session_id": "s-d",\n\t"hook_event_name": "%s",\n  "text": "quotes \\" and caf\xc3\xa9 \xe2\x9c\x93"\n}' "$ev")
  printf '%s' "$input" > "$TMP_ROOT/expected-stdin"
  run_hook "$DISCORD" "$input" "$ev"
  expect_status0 "$ev with the helper exits 0"
  if [ "$OUT" = "fake $ev output" ]; then pass "$ev prints the helper's output"; else fail "$ev prints the helper's output" "got: $OUT"; fi
  expect_file_has "$ev runs sk-discord hook $ev" "$H/fake/calls" "hook $ev"
  if cmp -s "$TMP_ROOT/expected-stdin" "$H/fake/stdin-$ev"; then pass "$ev passes stdin through byte for byte"; else fail "$ev passes stdin through byte for byte"; fi
done
expect_file_has "the helper sees the entry point" "$H/fake/entrypoint-session-start" "claude-desktop"
TEST_ENTRYPOINT=""

printf '{"decision":"block","reason":"Discord message(s) for this session: \\"hi\\""}\n' > "$H/fake/output-stop"
run_hook "$DISCORD" "$(event_input Stop)" stop
if json_valid && has '"decision":"block"'; then pass "the stop hook passes the block JSON through intact"; else fail "the stop hook passes the block JSON through intact" "$OUT"; fi
printf 'Discord: #s-d-desktop (Desktop)\nListener: sk-discord listen --session s-d\n' > "$H/fake/output-session-start"
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
if [ "$OUT" = "$(cat "$H/fake/output-session-start")" ]; then pass "session-start output is printed as the helper wrote it"; else fail "session-start output is printed as the helper wrote it" "$OUT"; fi

rm -f "$(discord_dir)/config.json"
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_lacks "with the helper installed, the hook doesn't print its own offer" "$OFFER_LINE"
write_config '{"enabled":true,"offered":true}'

rm -f "$H/fake/calls"
start_json=$(printf '{"session_id":"s-ss",\n"cwd":"/tmp",\t"hook_event_name":"SessionStart","source":"startup"}')
printf '%s' "$start_json" > "$TMP_ROOT/expected-stdin"
run_hook "$SESSION_START" "$start_json"
expect_status0 "session-start with the helper exits 0"
expect_has "session-start keeps its own lines" "Session id: s-ss"
expect_has "session-start still asks for the start skill" "$START_LINE"
expect_has "session-start appends the helper's lines" "Discord: #s-d-desktop (Desktop)"
if cmp -s "$TMP_ROOT/expected-stdin" "$H/fake/stdin-session-start"; then pass "session-start passes its stdin on unchanged"; else fail "session-start passes its stdin on unchanged"; fi
if [ "$(printf '%s\n' "$OUT" | tail -n 1)" = "Listener: sk-discord listen --session s-d" ]; then pass "the helper's lines come last"; else fail "the helper's lines come last" "$(printf '%s\n' "$OUT" | tail -n 1)"; fi

touch "$H/fake/fail"
for ev in session-start stop; do
  run_hook "$DISCORD" "$(event_input "$ev")" "$ev"
  expect_status0 "$ev exits 0 when the helper fails"
  expect_lacks "$ev prints nothing from a failed helper call" "error output"
done
rm -f "$H/fake/fail"

touch "$H/fake/sleep"
for ev in stop session-start; do
  SECONDS=0
  run_hook "$DISCORD" "$(event_input "$ev")" "$ev"
  elapsed=$SECONDS
  if [ "$elapsed" -le 6 ]; then pass "$ev returns within 6 seconds when the helper hangs (${elapsed}s)"; else fail "$ev returns within 6 seconds when the helper hangs" "${elapsed}s"; fi
  expect_status0 "$ev exits 0 when the helper hangs"
  expect_lacks "$ev prints nothing from a helper that was stopped" "partial output"
done
rm -f "$H/fake/sleep"

echo "== discord: version follow"
new_home dver
install_fake
echo 0.1.0 > "$H/fake/version"
write_config '{"enabled":true,"offered":true}'
TEST_PLUGIN_ROOT=$PLUGIN_020
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_status0 "a version mismatch exits 0"
expect_has "the helper's output still comes first" "fake session-start output"
if [ "$(count_of "$UPDATE_LINE 0.2.0.")" -eq 1 ]; then pass "a version mismatch prints one update line"; else fail "a version mismatch prints one update line" "$OUT"; fi
wait_for "$H/fake/updates"
if [ "$(cat "$H/fake/updates" 2>/dev/null)" = "update --version 0.2.0" ]; then pass "the helper gets update --version 0.2.0"; else fail "the helper gets update --version 0.2.0" "$(cat "$H/fake/updates" 2>/dev/null)"; fi
wait_for "$(discord_dir)/helper.log"
expect_file_has "the update's output goes to helper.log" "$(discord_dir)/helper.log" "updating to 0.2.0"

printf 'Discord: #s-d-cli (CLI)' > "$H/fake/output-session-start"
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
if printf '%s\n' "$OUT" | grep -q -x -F "$UPDATE_LINE 0.2.0."; then pass "the update line gets a line of its own"; else fail "the update line gets a line of its own" "$OUT"; fi
expect_has "helper output without a final newline is kept whole" "Discord: #s-d-cli (CLI)"
rm -f "$H/fake/output-session-start"
sleep 0.5

rm -f "$H/fake/updates"
for ev in stop notification; do
  run_hook "$DISCORD" "$(event_input "$ev")" "$ev"
  expect_lacks "$ev doesn't follow the version" "$UPDATE_LINE"
done
sleep 0.5
expect_no_file "other events start no update" "$H/fake/updates"

echo 0.2.0 > "$H/fake/version"
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_lacks "matching versions print no update line" "$UPDATE_LINE"
printf 'sk-discord v0.2.0\n' > "$H/fake/version"
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_lacks "a version printed with a name and a v still matches" "$UPDATE_LINE"
: > "$H/fake/version"
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_lacks "a helper that prints no version gets no update" "$UPDATE_LINE"
echo 0.1.0 > "$H/fake/version"

write_config '{"enabled":false,"offered":true}'
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_lacks "Discord turned off: no update line" "$UPDATE_LINE"
rm -f "$(discord_dir)/config.json"
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_lacks "no config.json: no update line" "$UPDATE_LINE"
sleep 0.5
expect_no_file "matching versions or Discord off start no update" "$H/fake/updates"

write_config '{"enabled":true,"offered":true}'
TEST_PLUGIN_ROOT=""
echo "$REPO_VERSION" > "$H/fake/version"
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_lacks "without CLAUDE_PLUGIN_ROOT, the hook's own plugin.json is used (same version)" "$UPDATE_LINE"
echo 0.0.1 > "$H/fake/version"
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
expect_has "without CLAUDE_PLUGIN_ROOT, the hook's own plugin.json is used (older helper)" "$UPDATE_LINE $REPO_VERSION."
wait_for "$H/fake/updates"
expect_file_has "the update goes to the plugin's own version" "$H/fake/updates" "update --version $REPO_VERSION"
echo 0.1.0 > "$H/fake/version"
rm -f "$H/fake/updates"

TEST_PLUGIN_ROOT=$PLUGIN_020
touch "$H/fake/update-sleep"
SECONDS=0
run_hook "$DISCORD" "$(start_input s-d startup)" session-start
elapsed=$SECONDS
if [ "$elapsed" -le 3 ]; then pass "a slow update runs detached (${elapsed}s)"; else fail "a slow update runs detached" "${elapsed}s"; fi
expect_has "a slow update still prints its line" "$UPDATE_LINE 0.2.0."
rm -f "$H/fake/update-sleep"
run_hook "$SESSION_START" "$(start_input s-d startup)"
expect_has "session-start passes on the update line" "$UPDATE_LINE 0.2.0."
TEST_PLUGIN_ROOT=""
TEST_UNAME=Linux

echo
printf '%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
