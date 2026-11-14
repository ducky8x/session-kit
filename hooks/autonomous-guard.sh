#!/usr/bin/env bash
# session-kit PreToolUse hook for the desktop app's prompts.
#
# In the Claude desktop app, the model ends each turn with
# mcp__ccd_turn__wrap_up. A call with an ask, buttons (actions) or
# blocked: true puts a question in the next-step box, and the session waits
# there for the user. mcp__ccd_session__start_session with initiation
# "offer" shows a New session / Do it here card and waits for the user too.
#
# While autonomous mode is on (autonomous.on in the session's state file),
# the user is away, so this hook denies those calls by printing
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
# The reason tells the model what to do instead. Other calls, and input it
# can't read, get no output, which lets the call through.
#
# Needs only bash and POSIX tools. It must never fail the session, so every
# path exits 0.

STATE_DIR_REL=.claude/session-kit/state  # under $HOME

WRAP_UP_REASON="session-kit: autonomous mode is on and the user is away, so nobody will answer a question or press a button in the next-step box. If the step you were going to ask about is safe and can be undone, such as the fix you found, a local commit or merge, or the next part of the work, do it now. If it needs the user, such as a push or force-push, deleting data, spending money, sending a message, or anything only they can do, skip it, carry on with any other work, and name it in the recap. Then call mcp__ccd_turn__wrap_up again with only the recap: no ask, actions or blocked. Don't ask the question in your closing message either."

OFFER_REASON="session-kit: autonomous mode is on and the user is away, so nobody will answer the offer card (New session or Do it here), and this call would wait for them. Do the work here in this session instead. If the user asked in their own words for a separate session, start it with initiation user_asked."

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

# json_fields: read one JSON value on stdin and print a line for each value
# one or two levels down:
#   <path> TAB <type> TAB <value>
# <path> joins the keys with dots (tool_input.ask). <type> is string, number,
# true, false, null, object or array. <value> is a string's text as written,
# escapes and all, a number, or the member count of an object or array.
# grep splits the input into tokens, taking each string whole, so a quote,
# brace or key name inside a string never counts. Input that isn't exactly
# one JSON value prints nothing.
json_fields() {
  # Control characters only appear as whitespace in valid JSON, so they all
  # become spaces, and a field can't hold a tab or a line break.
  tr '\000-\037' '[ *]' |
    LC_ALL=C grep -o -E '"([^"\\]|\\.)*"|true|false|null|-?[0-9][-+.0-9eE]*|[^ ]' |
    LC_ALL=C awk '
      function fail() { bad = 1; exit }
      # Record the value or container about to start at depth d.
      function start() {
        if (d == 0) p = ""
        else p = (cpath[d] == "" ? "" : cpath[d] ".") (kind[d] == "o" ? key[d] : count[d])
        level = d
        if (d > 0) count[d]++
      }
      # End the container at depth d with token c, if c ends it.
      function finish(c) {
        if (d == 0 || c != (kind[d] == "o" ? "}" : "]")) return 0
        if (clevel[d] == 1 || clevel[d] == 2)
          out[++n] = cpath[d] "\t" (kind[d] == "o" ? "object" : "array") "\t" count[d]
        d--
        want = (d == 0 ? "end" : "next")
        return 1
      }
      BEGIN { d = 0; n = 0; want = "value" }
      {
        t = $0
        c = substr(t, 1, 1)
        if (c == "\"" && t !~ /^"([^"\\]|\\.)*"$/) fail()
        if (want == "end") fail()
        if (want == "colon") {
          if (c != ":") fail()
          want = "value"
          next
        }
        if (want == "next") {
          if (c == ",") {
            want = (kind[d] == "o" ? "key" : "value")
            empty = 0
          } else if (!finish(c)) fail()
          next
        }
        if (empty && (c == "}" || c == "]")) {
          if (!finish(c)) fail()
          next
        }
        if (want == "key") {
          if (c != "\"") fail()
          key[d] = substr(t, 2, length(t) - 2)
          want = "colon"
          empty = 0
          next
        }
        # want is "value".
        start()
        if (c == "{" || c == "[") {
          d++
          kind[d] = (c == "{" ? "o" : "a")
          cpath[d] = p
          clevel[d] = level
          count[d] = 0
          want = (c == "{" ? "key" : "value")
          empty = 1
          next
        }
        if (c == "\"") { type = "string"; v = substr(t, 2, length(t) - 2) }
        else if (t == "true" || t == "false" || t == "null") { type = t; v = t }
        else if (t ~ /^-?[0-9]/) { type = "number"; v = t }
        else fail()
        if (level == 1 || level == 2) out[++n] = p "\t" type "\t" v
        want = (d == 0 ? "end" : "next")
        empty = 0
      }
      END {
        if (bad || want != "end") exit
        for (i = 1; i <= n; i++) print out[i]
      }'
}

# field <fields> <path> <type>: print the value at <path> if it has <type>.
# When a key repeats, the last one counts, as in JSON.parse.
field() {
  printf '%s\n' "$1" |
    awk -F '\t' -v p="$2" -v t="$3" '$1 == p { v = ($2 == t ? $3 : "") } END { printf "%s", v }'
}

# autonomous_on <state file>: succeed if autonomous.on is true in it.
autonomous_on() {
  local state
  [ -f "$1" ] && [ -r "$1" ] || return 1
  state=$(tr '\n\r\t' '   ' < "$1" 2>/dev/null)
  # "on" is a key in the cloud object too, so read it inside autonomous.
  [ "$(json_bool "$(json_obj "$state" autonomous)" on)" = true ]
}

main() {
  local fields sid reason actions
  if [ -z "${HOME:-}" ]; then
    [ -t 0 ] || cat > /dev/null 2>&1
    return 0
  fi
  [ -t 0 ] && return 0
  fields=$(json_fields)
  sid=$(field "$fields" session_id string)
  # The id becomes a file name: allow only safe characters.
  case $sid in
    '' | .* | *[!A-Za-z0-9._-]*) return 0 ;;
  esac

  case $(field "$fields" tool_name string) in
    mcp__ccd_turn__wrap_up)
      # An empty ask or an empty actions list shows nothing.
      actions=$(field "$fields" tool_input.actions array)
      if [ -n "$(field "$fields" tool_input.ask string)" ] ||
        [ "${actions:-0}" -gt 0 ] ||
        [ "$(field "$fields" tool_input.blocked true)" = true ]; then
        reason=$WRAP_UP_REASON
      fi
      ;;
    mcp__ccd_session__start_session)
      [ "$(field "$fields" tool_input.initiation string)" = offer ] && reason=$OFFER_REASON
      ;;
  esac
  [ -n "$reason" ] || return 0

  autonomous_on "$HOME/$STATE_DIR_REL/$sid.json" || return 0
  # The reasons hold no quotes or backslashes, so they need no escaping.
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
}

main 2>/dev/null
exit 0
