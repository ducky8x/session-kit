#!/usr/bin/env bash
# session-kit Discord hook.
#
# usage: discord.sh <event>
#   <event> is session-start, session-end, notification, pre-ask, post-ask
#   or stop. The hook's JSON input arrives on stdin.
#
# When the Discord helper is installed (~/.claude/session-kit/bin/sk-discord),
# this runs `sk-discord hook <event>` with the same stdin, stops it after 5
# seconds, and prints what it printed. On session-start it also keeps the
# helper at the plugin's version: when the two differ and Discord is on, it
# starts `sk-discord update --version <v>` in the background.
#
# Without the helper it prints nothing, except on session-start on macOS:
# the first-run offer when Discord was never offered (no config.json), or a
# set-up line when Discord is turned on but the helper is missing.
#
# SK_DISCORD_UNAME stands in for `uname -s`; only the tests set it.
#
# Needs only bash and POSIX tools. It must never fail the session, so every
# path exits 0.

HOOK_LIMIT=5     # seconds a `sk-discord hook` call may run
VERSION_LIMIT=2  # seconds `sk-discord --version` may run

TMP_DIR=""
trap '[ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"' EXIT

# json_str <flattened json> <key>: print the string value of <key>, if any.
json_str() {
  printf '%s' "$1" |
    sed -n -E 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' |
    head -n 1
}

# json_bool <flattened json> <key>: print true or false, if set.
json_bool() {
  printf '%s' "$1" |
    sed -n -E 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*(true|false).*/\1/p' |
    head -n 1
}

flatten() { tr '\n\r\t' '   ' < "$1" 2>/dev/null; }

# run_limited <seconds> <stdin file> <stdout file> <command...>: run the
# command with stdin and stdout on those files, and kill it if it still runs
# after <seconds>. Returns its exit status, which is not 0 when it was killed.
run_limited() {
  local secs=$1 in=$2 out=$3 pid watcher status
  shift 3
  "$@" < "$in" > "$out" 2>/dev/null &
  pid=$!
  # The watcher holds no copy of this hook's stdout, so it can't keep the
  # session waiting. When it is stopped, it stops its sleep too, even if the
  # stop comes before the sleep's pid is known.
  (
    trap 'early=1' TERM
    sleep "$secs" &
    s=$!
    trap 'kill "$s" 2>/dev/null; exit 0' TERM
    if [ -n "${early:-}" ]; then kill "$s"; exit 0; fi
    wait "$s"
    kill -9 "$pid"
  ) > /dev/null 2>&1 &
  watcher=$!
  wait "$pid"
  status=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return "$status"
}

# Lines for session-start when the helper isn't installed. <input> is the
# flattened hook input.
not_installed_lines() {
  local config="$1" input="$2" os source
  os=${SK_DISCORD_UNAME:-$(uname -s 2>/dev/null)}
  [ "$os" = Darwin ] || return 0
  source=$(json_str "$input" source)
  if [ -f "$config" ]; then
    [ "$(json_bool "$(flatten "$config")" enabled)" = true ] || return 0
    # After a summary of the chat the session keeps working; it heard this
    # line when it started.
    [ "$source" = compact ] && return 0
    printf 'Discord: turned on, but the helper isn'"'"'t installed. Before other work, invoke the session-kit:discord skill to finish the setup, or turn Discord off with /discord off.\n'
  else
    # Only a new session runs the start skill, which asks the question.
    case $source in
      startup | clear | '')
        printf 'Discord: not offered yet. Add the question "Set up Discord now?" to the startup questions (session-kit:start skill).\n'
        ;;
    esac
  fi
}

# follow_version <helper> <config>: start an update in the background when
# the helper's version differs from the plugin's and Discord is on.
follow_version() {
  local bin=$1 config=$2 root manifest want have none out dir
  [ -f "$config" ] || return 0
  [ "$(json_bool "$(flatten "$config")" enabled)" = true ] || return 0
  root=${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}
  manifest="$root/.claude-plugin/plugin.json"
  [ -f "$manifest" ] || return 0
  want=$(json_str "$(flatten "$manifest")" version)
  case $want in
    '' | *[!A-Za-z0-9.+-]*) return 0 ;;
  esac
  none="$TMP_DIR/none" out="$TMP_DIR/version"
  : > "$none" || return 0
  run_limited "$VERSION_LIMIT" "$none" "$out" "$bin" --version || return 0
  # Accept "0.2.0", "v0.2.0" or "sk-discord 0.2.0".
  have=$(sed -n -E 's/^[^0-9]*([0-9]+(\.[0-9]+)+[-+.A-Za-z0-9]*).*/\1/p' "$out" | head -n 1)
  [ -n "$have" ] && [ "$have" != "$want" ] || return 0
  dir=$(dirname "$config")
  # A subshell around the background job detaches it from this hook, and
  # its output goes to the log, so the session never waits for it.
  ( nohup "$bin" update --version "$want" >> "$dir/helper.log" 2>&1 < /dev/null & ) 2>/dev/null
  printf 'Updating the Discord helper to %s.\n' "$want"
}

main() {
  local event=${1:-} bin config in out
  if [ -z "${HOME:-}" ]; then
    [ -t 0 ] || cat > /dev/null 2>&1
    return 0
  fi
  case $event in
    session-start | session-end | notification | pre-ask | post-ask | stop) ;;
    *)
      [ -t 0 ] || cat > /dev/null 2>&1
      return 0
      ;;
  esac

  bin="$HOME/.claude/session-kit/bin/sk-discord"
  config="$HOME/.claude/session-kit/discord/config.json"

  if [ ! -f "$bin" ] || [ ! -x "$bin" ]; then
    if [ "$event" = session-start ] && [ ! -t 0 ]; then
      not_installed_lines "$config" "$(tr '\n\r\t' '   ')"
    elif [ ! -t 0 ]; then
      cat > /dev/null 2>&1
    fi
    return 0
  fi

  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sk-discord.XXXXXX") || return 0
  in="$TMP_DIR/in" out="$TMP_DIR/out"
  if [ -t 0 ]; then
    : > "$in"
  else
    cat > "$in"
  fi
  if run_limited "$HOOK_LIMIT" "$in" "$out" "$bin" hook "$event"; then
    cat "$out"
    # End with a newline, so a line printed after it starts on its own.
    [ -z "$(tail -c 1 "$out")" ] || printf '\n'
  fi
  if [ "$event" = session-start ]; then
    follow_version "$bin" "$config"
  fi
  return 0
}

main "$@" 2>/dev/null
exit 0
