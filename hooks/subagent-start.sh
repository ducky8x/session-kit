#!/usr/bin/env bash
# session-kit SubagentStart hook.
#
# Gives every subagent the user's rules file and a note that it is a
# subagent. SubagentStart doesn't add plain stdout to the subagent's
# context, so this prints
#   {"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"..."}}
# with the JSON string escaping done in awk (no python3 or jq needed).
#
# It must never fail the subagent, so every path exits 0.

RULES_LIMIT=8000  # bytes; a larger rules file is not loaded inline

file_size() { wc -c < "$1" 2>/dev/null | tr -d ' '; }

context_text() {
  local rules="$HOME/.claude/session-kit/rules.md" size
  printf 'session-kit: you are a subagent. Don'"'"'t run the session-kit:start skill; the main agent already set up this session.\n'
  [ -f "$rules" ] && [ -r "$rules" ] || return 0
  size=$(file_size "$rules")
  [ -n "$size" ] || return 0
  if [ "$size" -le "$RULES_LIMIT" ]; then
    printf '\nThe user'"'"'s standing rules from ~/.claude/session-kit/rules.md follow. They apply to your work too.\n\n'
    cat "$rules"
  else
    printf '\nThe user'"'"'s standing rules are in %s (%s bytes, over the %s-byte limit for loading here). Read the whole file with the Read tool before any real work, and follow it.\n' \
      "$rules" "$size" "$RULES_LIMIT"
  fi
}

# Read stdin as a JSON string body: escape backslash, double quote, tab,
# carriage return and other control characters, and turn each line end
# into \n. NUL bytes are dropped. Bytes 0x80 and up pass through unchanged,
# so UTF-8 text stays intact.
json_escape() {
  tr -d '\000' | LC_ALL=C awk '
    BEGIN {
      for (i = 1; i < 32; i++) esc[sprintf("%c", i)] = sprintf("\\u%04x", i)
      esc["\t"] = "\\t"
      esc["\r"] = "\\r"
      esc["\""] = "\\\""
      esc["\\"] = "\\\\"
    }
    {
      out = ""
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (c in esc) out = out esc[c]
        else out = out c
      }
      printf "%s", out "\\n"
    }'
}

main() {
  local body
  [ -n "${HOME:-}" ] || return 0
  # The input isn't needed; read it so the writer never hits a closed pipe.
  [ -t 0 ] || cat > /dev/null 2>&1
  body=$(context_text | json_escape) || return 0
  [ -n "$body" ] || return 0
  printf '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"%s"}}\n' "$body"
}

main 2>/dev/null
exit 0
