#!/usr/bin/env bash
# Tests for the session-kit hooks. Run with: bash tests/test-hooks.sh
# Each test runs a hook with a throwaway HOME and fake stdin JSON, so the
# real ~/.claude is never read or written. Needs python3 to check JSON.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SESSION_START="$ROOT/hooks/session-start.sh"
SUBAGENT_START="$ROOT/hooks/subagent-start.sh"
HOOKS_JSON="$ROOT/hooks/hooks.json"

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/session-kit-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP_ROOT"' EXIT

passed=0
failed=0
H=""        # HOME for the current test
OUT=""      # stdout of the last hook run
STATUS=0    # exit status of the last hook run
TEST_LOCALE=C

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

# run_hook <script> <stdin text>
run_hook() {
  OUT=$(printf '%s' "$2" | env -i HOME="$H" PATH="$PATH" LC_ALL="$TEST_LOCALE" "$1" 2>/dev/null)
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
  awk -v n="$2" 'BEGIN { for (i = 0; i < n - 1; i++) printf (i % 80 == 79) ? "\n" : "x"; printf "\n" }' > "$1"
}

json_valid() { printf '%s' "$OUT" | python3 -c 'import json,sys;json.load(sys.stdin)' 2>/dev/null; }

START_LINE="invoke the session-kit:start skill"
HINT="no rules file yet"
NO_ASK="don't ask the startup questions again"

echo "== files"
for f in "$SESSION_START" "$SUBAGENT_START"; do
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

echo
printf '%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
