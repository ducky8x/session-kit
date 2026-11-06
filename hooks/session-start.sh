#!/usr/bin/env bash
# session-kit SessionStart hook.
#
# Prints context for the model on stdout; Claude Code adds a SessionStart
# hook's plain stdout to the session's context. It prints the session id and
# state file path, asks for the start skill on a new session, restates the
# saved setup after a resume or a summary of the chat, and loads the user's
# rules file. It also prunes old state files. At the end it passes its input
# on to discord.sh and adds that hook's lines, if any.
#
# Needs only bash and POSIX tools. It must never fail the session, so every
# path exits 0.

RULES_LIMIT=8000       # bytes; a larger rules file is not loaded inline
STATE_MAX_AGE_DAYS=30  # state files older than this are pruned
TASK_MAX_CHARS=200     # cap on the task text restated after a restore

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

# json_obj <flattened json> <key>: print the body of the object <key>, if
# any, without its braces. The object must hold no other object; braces
# inside its string values are fine.
json_obj() {
  printf '%s' "$1" |
    sed -n -E 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*\{(([^{}"]|"([^"\\]|\\.)*")*)\}.*/\1/p' |
    head -n 1
}

file_size() { wc -c < "$1" 2>/dev/null | tr -d ' '; }

print_rules() {
  local rules="$HOME/.claude/session-kit/rules.md" state_dir=$1 sid=$2 size
  if [ -f "$rules" ] && [ -r "$rules" ]; then
    size=$(file_size "$rules")
    [ -n "$size" ] || return 0
    if [ "$size" -le "$RULES_LIMIT" ]; then
      printf '\nThe user'"'"'s standing rules from ~/.claude/session-kit/rules.md follow. They hold for the whole session, in the main agent and in every subagent.\n\n'
      cat "$rules"
      # End with a newline even if the file doesn't.
      [ -z "$(tail -c 1 "$rules")" ] || printf '\n'
    else
      printf '\nThe user'"'"'s standing rules are in %s (%s bytes, over the %s-byte limit for loading here). Read the whole file with the Read tool before any real work, and follow it for the whole session.\n' \
        "$rules" "$size" "$RULES_LIMIT"
    fi
  elif [ -z "$(find "$state_dir" -maxdepth 1 -type f -name '*.json' ! -name "$sid.json" 2>/dev/null | head -n 1)" ]; then
    # First run: no other session has saved a state file yet.
    printf '\nTip: no rules file yet. Standing rules kept in ~/.claude/session-kit/rules.md load into every session and subagent; the session-kit:start skill explains how to create one.\n'
  fi
}

# describe_setup <state file>: one line such as
# "Workflow: multi-agent · Autonomous: ON (this session) · Cloud agents: ON".
# The cloud part is left out when the file has no cloud object.
describe_setup() {
  local state auto cloud workflow on scope task w a c=""
  state=$(tr '\n\r\t' '   ' < "$1" 2>/dev/null)
  workflow=$(json_str "$state" workflow)
  # "on" is a key in both objects, so read each one inside its own object.
  auto=$(json_obj "$state" autonomous)
  cloud=$(json_obj "$state" cloud)
  on=$(json_bool "$auto" on)
  scope=$(json_str "$auto" scope)
  task=$(json_str "$auto" task | sed -e 's/\\[nrt]/ /g' -e 's/\\"/"/g' -e 's/\\\\/\\/g')
  case $workflow in
    single) w="single-agent" ;;
    multi) w="multi-agent" ;;
    *) w="not set" ;;
  esac
  if [ "$on" = true ]; then
    if [ "$scope" = task ]; then
      if [ -n "$task" ]; then
        [ "${#task}" -le "$TASK_MAX_CHARS" ] || task="${task:0:$TASK_MAX_CHARS}..."
        a="ON (until $task is done)"
      else
        a="ON (this task)"
      fi
    else
      a="ON (this session)"
    fi
  else
    a="OFF"
  fi
  if [ -n "$cloud" ]; then
    if [ "$(json_bool "$cloud" on)" != true ]; then
      c=" · Cloud agents: OFF"
    elif [ "$(json_str "$cloud" remote)" = unavailable ]; then
      c=" · Cloud agents: ON (running locally: not available)"
    else
      c=" · Cloud agents: ON"
    fi
  fi
  printf 'Workflow: %s · Autonomous: %s%s' "$w" "$a" "$c"
}

# print_discord <hook input>: run discord.sh session-start with the same
# input, and add what it prints after a blank line.
print_discord() {
  local hook out
  hook="$(dirname "$0")/discord.sh"
  [ -f "$hook" ] || return 0
  out=$(printf '%s' "$1" | "${BASH:-bash}" "$hook" session-start 2>/dev/null)
  [ -n "$out" ] || return 0
  printf '\n%s\n' "$out"
}

main() {
  local raw="" input sid source state_dir state_file state
  [ -n "${HOME:-}" ] || return 0
  if [ ! -t 0 ]; then
    raw=$(cat 2>/dev/null)
  fi
  input=$(printf '%s' "$raw" | tr '\n\r\t' '   ')
  sid=$(json_str "$input" session_id)
  source=$(json_str "$input" source)
  # The id becomes a file name: allow only safe characters.
  case $sid in
    '' | .* | *[!A-Za-z0-9._-]*) return 0 ;;
  esac

  state_dir="$HOME/.claude/session-kit/state"
  state_file="$state_dir/$sid.json"

  if [ -d "$state_dir" ]; then
    find "$state_dir" -maxdepth 1 -type f -name '*.json' ! -name "$sid.json" \
      -mtime +"$STATE_MAX_AGE_DAYS" -exec rm -f {} + 2>/dev/null
    # Keep this session's file from being pruned while it is in use.
    [ -f "$state_file" ] && touch "$state_file" 2>/dev/null
  fi

  printf 'session-kit\n'
  printf 'Session id: %s\n' "$sid"
  printf 'State file: %s\n' "$state_file"

  case $source in
    startup | clear | '')
      printf 'This is a new session. Before anything else in your first response, invoke the session-kit:start skill and follow it: it sets the workflow (single-agent or multi-agent) and whether the session runs autonomously. Skip it if you are a subagent or the session is non-interactive (print mode).\n'
      ;;
    *)
      if [ -f "$state_file" ]; then
        state=$(tr '\n\r\t' '   ' < "$state_file" 2>/dev/null)
        printf 'Session setup (restored): %s\n' "$(describe_setup "$state_file")"
        printf 'This setup was saved earlier in this session. Keep working with it: don'"'"'t ask the startup questions again, and don'"'"'t toggle autonomous mode because of this note.\n'
        if [ "$(json_bool "$(json_obj "$state" cloud)" on)" = true ]; then
          printf 'Cloud agent rules: %s (read it before dispatching).\n' \
            "${CLAUDE_PLUGIN_ROOT:-the session-kit plugin folder}/skills/start/cloud.md"
        fi
        if [ "$source" = resume ] && [ "$(json_bool "$(json_obj "$state" autonomous)" on)" = true ]; then
          printf 'Background commands and heartbeats from before the resume have stopped. If unattended work is still under way, start keep-awake and the heartbeat again as described in %s, and record the new ids in the state file. Read that file rather than invoking the skill, which would toggle the mode.\n' \
            "${CLAUDE_PLUGIN_ROOT:-the session-kit plugin folder}/skills/autonomous-mode/SKILL.md"
        fi
      elif [ "$source" = fork ]; then
        printf 'This session was forked from another one. Keep the setup the conversation already settled and don'"'"'t ask the startup questions again. Save that setup to the state file above so it survives a summary of the chat.\n'
      else
        printf 'No setup was saved for this session. Keep the setup the conversation already settled (single-agent and not autonomous if none), and don'"'"'t ask the startup questions again.\n'
      fi
      ;;
  esac

  print_rules "$state_dir" "$sid"
  print_discord "$raw"
}

main 2>/dev/null
exit 0
