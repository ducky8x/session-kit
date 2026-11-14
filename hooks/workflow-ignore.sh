#!/usr/bin/env bash
# session-kit workflow-ignore hook. session-start.sh runs it with the same
# SessionStart input on stdin.
#
# Keeps workflow files (.agentcontext, CLAUDE.md, .task/ and the like) out of
# git in every repo. It does nothing unless ~/.claude/session-kit/ignore
# exists. That file holds gitignore patterns, one per line; blank lines and
# lines that start with # are skipped.
#
# 1. It adds each listed pattern that's missing to git's global ignore file:
#    the global core.excludesFile, or ${XDG_CONFIG_HOME:-~/.config}/git/ignore
#    when that's unset. New lines go under a "# session-kit: workflow files"
#    header. It never edits git config, and the file's other lines stay as
#    they are.
# 2. If the session's folder (cwd in the input) is in a git work tree, it
#    names the files there that match a pattern and are tracked, and the
#    listed files and folders that exist but still aren't ignored. Untracking
#    them is left to the session.
#
# It prints a line only when it changed the global file or found a problem.
#
# Needs bash, POSIX tools and git. It must never fail the session, so every
# path exits 0.

HEADER="# session-kit: workflow files"
LOCK_TRIES=10  # tries, 0.1 seconds apart, to take the lock before giving up
MAX_NAMES=10   # file names listed in one line

NL='
'
TMP_DIR=""
LOCK_DIR=""  # set while this run holds the lock
cleanup() {
  [ -z "$LOCK_DIR" ] || rmdir "$LOCK_DIR"
  [ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"
}
trap 'cleanup 2>/dev/null' EXIT

# json_str <flattened json> <key>: print the string value of <key>, if any.
json_str() {
  printf '%s' "$1" |
    sed -n -E 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' |
    head -n 1
}

# unescape <json string body>: undo the escapes a path can hold.
unescape() { printf '%s' "$1" | sed -e 's/\\"/"/g' -e 's/\\\//\//g' -e 's/\\\\/\\/g'; }

# tilde <path>: the path with $HOME shown as ~.
tilde() {
  case $1 in
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# names <newline-separated list>: "a, b, c", cut to MAX_NAMES names and
# "and N more".
names() {
  printf '%s\n' "$1" | awk -v max="$MAX_NAMES" '
    { n++; if (n <= max) out = out (n > 1 ? ", " : "") $0 }
    END { if (n > max) out = out " and " (n - max) " more"; printf "%s", out }'
}

# excludes_file: print the path of git's global ignore file. Prints nothing
# when core.excludesFile is empty (git then reads no global file) or isn't
# an absolute path, and fails when git can't read its config.
excludes_file() {
  local f status
  f=$(git config --global --get core.excludesFile)
  status=$?
  case $status in
    0) case $f in '~/'*) f="$HOME/${f#'~/'}" ;; esac ;;
    1) f="${XDG_CONFIG_HOME:-$HOME/.config}/git/ignore" ;;
    *) return 1 ;;
  esac
  case $f in
    /* | [A-Za-z]:[\\/]*) printf '%s' "$f" ;;
  esac
}

# missing <pattern file> <ignore file>: print the patterns that aren't a
# line of the ignore file, trailing whitespace aside.
missing() {
  local have=$2
  [ -f "$have" ] || have=/dev/null
  awk 'FILENAME == ARGV[1] { sub(/[ \t\r]+$/, ""); have[$0] = 1; next }
       !($0 in have) { have[$0] = 1; print }' "$have" "$1"
}

# take_lock: take ~/.claude/session-kit/ignore.lock, so two sessions that
# start at once don't both write. Fails if another run holds it.
take_lock() {
  local lock="$HOME/.claude/session-kit/ignore.lock" i=0
  until mkdir "$lock"; do
    i=$((i + 1))
    [ "$i" -le "$LOCK_TRIES" ] || return 1
    # A run that was killed leaves its lock behind. One over a minute old
    # is stale.
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +1)" ]; then
      rmdir "$lock"
    else
      sleep 0.1
    fi
  done
  LOCK_DIR=$lock
}

# update_global <pattern file>: add the patterns the global ignore file
# lacks, and print one line saying so.
update_global() {
  local patterns=$1 file new end total count
  file=$(excludes_file) || return 0
  [ -n "$file" ] && [ ! -d "$file" ] || return 0
  [ -n "$(missing "$patterns" "$file")" ] || return 0
  take_lock || return 0
  # Check again: another session may have added them while this one waited.
  new=$(missing "$patterns" "$file")
  [ -n "$new" ] || return 0
  mkdir -p "$(dirname "$file")" || return 0

  if [ -s "$file" ]; then
    # The last line of an existing session-kit block, if there is one.
    end=$(awk -v hdr="$HEADER" '
      { line = $0; sub(/[ \t\r]+$/, "", line) }
      !in_block && !done && line == hdr { in_block = 1; end = NR; next }
      in_block { if (line == "" || substr(line, 1, 1) == "#") { in_block = 0; done = 1 } else end = NR }
      END { if (end) print end }' "$file")
    total=$(awk 'END { print NR }' "$file")
  fi

  # The file is written in place, so a symlinked file stays a symlink.
  if [ -n "$end" ] && [ "$end" -lt "$total" ]; then
    # The block is followed by other lines: put the new ones after it.
    {
      head -n "$end" "$file"
      printf '%s\n' "$new"
      tail -n "+$((end + 1))" "$file"
    } > "$TMP_DIR/new-ignore" && cat "$TMP_DIR/new-ignore" > "$file" || return 0
  else
    {
      if [ -s "$file" ]; then
        [ -z "$(tail -c 1 "$file")" ] || printf '\n'
        if [ -z "$end" ]; then
          # A blank line before the header, unless the file ends with one.
          [ -z "$(tail -n 1 "$file" | tr -d ' \t\r')" ] || printf '\n'
        fi
      fi
      [ -n "$end" ] || printf '%s\n' "$HEADER"
      printf '%s\n' "$new"
    } >> "$file" || return 0
  fi

  count=$(printf '%s\n' "$new" | wc -l | tr -d ' ')
  if [ "$count" -eq 1 ]; then count="1 pattern"; else count="$count patterns"; fi
  printf 'session-kit added %s from ~/.claude/session-kit/ignore to the global git ignore file, %s.\n' \
    "$count" "$(tilde "$file")"
}

# check_repo <folder> <pattern file>: if the folder is in a git work tree,
# name the workflow files there that are tracked or not ignored.
check_repo() {
  local cwd=$1 patterns=$2 info top prefix tracked p name dir_only paths path
  local candidates="" ignored loose=""
  [ -d "$cwd" ] || return 0
  info=$(git -C "$cwd" rev-parse --is-inside-work-tree --show-toplevel --show-prefix) || return 0
  [ "$(printf '%s\n' "$info" | sed -n 1p)" = true ] || return 0
  top=$(printf '%s\n' "$info" | sed -n 2p)
  prefix=$(printf '%s\n' "$info" | sed -n 3p)
  [ -d "$top" ] || return 0

  # Tracked files that match a pattern, as gitignore matches them.
  tracked=$(git -C "$top" ls-files -z -c -i --exclude-from="$patterns" | tr '\0' '\n')

  # Files and folders named by a plain pattern (no wildcards) that exist,
  # at the top of the repo and in the session's folder, and aren't tracked.
  while IFS= read -r p; do
    case $p in '!'* | *[*?[\\]*) continue ;; esac
    dir_only=""
    case $p in */) dir_only=1 ;; esac
    name=${p%/}
    case $name in
      '' | */) continue ;;
      */*) paths=${name#/} ;;  # a slash ties the pattern to the top
      *) paths=$name; [ -z "$prefix" ] || paths="$paths$NL$prefix$name" ;;
    esac
    while IFS= read -r path; do
      if [ -n "$dir_only" ]; then
        [ -d "$top/$path" ] || continue
      else
        [ -e "$top/$path" ] || continue
      fi
      case "$NL$tracked$NL" in *"$NL$path$NL"* | *"$NL$path/"*) continue ;; esac
      case "$NL$candidates$NL" in *"$NL$path$NL"*) continue ;; esac
      candidates="$candidates${candidates:+$NL}$path"
    done <<< "$paths"
  done < "$patterns"

  if [ -n "$candidates" ]; then
    printf '%s\n' "$candidates" | tr '\n' '\0' |
      git -C "$top" check-ignore -z --stdin > "$TMP_DIR/ignored"
    # 0: some are ignored; 1: none are. Anything else is an error.
    case $? in
      0 | 1)
        ignored=$(tr '\0' '\n' < "$TMP_DIR/ignored")
        while IFS= read -r path; do
          case "$NL$ignored$NL" in *"$NL$path$NL"*) continue ;; esac
          [ ! -d "$top/$path" ] || path="$path/"
          loose="$loose${loose:+$NL}$path"
        done <<< "$candidates"
        ;;
    esac
  fi

  if [ -n "$tracked" ]; then
    printf 'Workflow files tracked in this repo: %s. Untrack them with `git rm --cached` and commit that on its own branch. Git history still holds them, and rewriting history that has been pushed needs the user'"'"'s OK.\n' \
      "$(names "$tracked")"
  fi
  if [ -n "$loose" ]; then
    printf 'Workflow files not ignored in this repo: %s. Look for what re-includes them, such as a `!` line in the repo'"'"'s .gitignore, and keep them out of commits.\n' \
      "$(names "$loose")"
  fi
}

main() {
  local raw="" list cwd patterns
  [ -n "${HOME:-}" ] || return 0
  if [ ! -t 0 ]; then
    raw=$(cat)
  fi
  list="$HOME/.claude/session-kit/ignore"
  [ -f "$list" ] && [ -r "$list" ] || return 0
  command -v git >/dev/null || return 0
  cwd=$(json_str "$(printf '%s' "$raw" | tr '\n\r\t' '   ')" cwd)
  [ -n "$cwd" ] || return 0
  cwd=$(unescape "$cwd")

  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/session-kit-ignore.XXXXXX") || return 0
  patterns="$TMP_DIR/patterns"
  tr -d '\r' < "$list" |
    awk '{ sub(/^[ \t]+/, ""); sub(/[ \t]+$/, "") }
         $0 != "" && substr($0, 1, 1) != "#" && !seen[$0]++' > "$patterns"
  [ -s "$patterns" ] || return 0

  update_global "$patterns"
  check_repo "$cwd" "$patterns"
}

main 2>/dev/null
exit 0
