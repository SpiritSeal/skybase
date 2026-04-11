#!/usr/bin/env bash
#
# skybase-notify — emit a desktop notification escape sequence to the
# controlling terminal. Drop-in replacement for `cmux notify`. Designed to be
# called from agent hooks (Claude Code Stop / PostToolUse, GitHub Copilot CLI,
# etc.) on a remote host that the user is currently attached to via skybase.
#
# Why this script can't just printf to stdout:
#   When called from a Claude Code hook, the hook subprocess does NOT have
#   the controlling terminal of the tmux pane on its stdout — Claude captures
#   it. We must write the OSC bytes to /dev/tty (or $TTY) so they reach the
#   pane's terminal device directly. Bytes then flow up through the PTY back
#   to the skybase server, which strips the OSC and emits a push notification.
#
# Why this script may need to wrap in tmux passthrough:
#   tmux drops unknown OSC sequences in pane output by default. Wrapping the
#   sequence in tmux's DCS passthrough envelope (`\ePtmux;\e<seq>\e\\`) tells
#   tmux to forward it. The user must ALSO have `set -g allow-passthrough on`
#   in their .tmux.conf — without that, tmux drops the whole DCS too.
#
# Usage:
#   skybase-notify --title "Claude" --body "Task complete"
#   skybase-notify -t "Build" -b "Failed" --dedupe-id build:1234
#
# Flags (compatible with `cmux notify`):
#   -t, --title TEXT       notification title
#   -b, --body  TEXT       notification body
#   --subtitle TEXT        secondary title (mapped into body for OSC 777)
#   --dedupe-id ID         id used by the server to suppress repeats
#   -h, --help             show help and exit

set -eu

prog=$(basename "$0")

usage() {
    cat <<EOF
$prog — emit a desktop notification through skybase via OSC escape sequence

Usage: $prog [--title TITLE] [--body BODY] [--subtitle SUB] [--dedupe-id ID]

Compatible with \`cmux notify\`. Symlink \`cmux\` -> \`$prog\` for drop-in use.
EOF
}

title=""
body=""
subtitle=""
dedupe_id=""

while [ $# -gt 0 ]; do
    case "$1" in
        -t|--title)
            title="${2:-}"; shift 2 ;;
        -b|--body)
            body="${2:-}"; shift 2 ;;
        --subtitle)
            subtitle="${2:-}"; shift 2 ;;
        --dedupe-id|-d)
            dedupe_id="${2:-}"; shift 2 ;;
        -h|--help)
            usage; exit 0 ;;
        --)
            shift; break ;;
        -*)
            echo "$prog: unknown flag: $1" >&2
            usage >&2
            exit 2
            ;;
        *)
            # Positional: first = title, second = body (cmux compat).
            if [ -z "$title" ]; then
                title="$1"
            elif [ -z "$body" ]; then
                body="$1"
            fi
            shift
            ;;
    esac
done

# OSC 777 disallows literal semicolons in fields (they are field separators).
# Sanitize by replacing with U+FF1B (fullwidth semicolon) — visually identical
# in a notification, won't break the parser.
sanitize() {
    printf '%s' "$1" | tr ';' '\357\274\233'
}
title=$(sanitize "$title")
body=$(sanitize "$body")
if [ -n "$subtitle" ]; then
    subtitle=$(sanitize "$subtitle")
    # Fold subtitle into body since OSC 777 has no separate subtitle field.
    if [ -n "$body" ]; then
        body="$subtitle — $body"
    else
        body="$subtitle"
    fi
fi

# Build the OSC 777 sequence. Bash interprets \033 (ESC) and \a (BEL) under
# printf '%b' for the format-string portion. We use printf to assemble the
# bytes verbatim.
esc=$(printf '\033')
bel=$(printf '\a')
osc="${esc}]777;notify;${title};${body}${bel}"

# If we have a dedupe id, additionally emit an OSC 99 with `i=<id>` so the
# server's dedup map can collapse repeats by explicit id (more reliable than
# content hashing).
if [ -n "$dedupe_id" ]; then
    osc99_body="${esc}]99;i=${dedupe_id};${body}${bel}"
else
    osc99_body=""
fi

# When inside tmux, wrap the OSC in tmux's DCS passthrough envelope so tmux
# forwards it to the outer terminal. Inner ESC bytes must be DOUBLED per the
# DCS passthrough spec.
wrap_for_tmux() {
    local inner="$1"
    # Double every ESC.
    local doubled
    doubled=$(printf '%s' "$inner" | sed "s/${esc}/${esc}${esc}/g")
    printf '%sPtmux;%s%s\\' "$esc" "$doubled" "$esc"
}

if [ -n "${TMUX:-}" ]; then
    out=$(wrap_for_tmux "$osc")
    if [ -n "$osc99_body" ]; then
        out="${out}$(wrap_for_tmux "$osc99_body")"
    fi
else
    out="$osc${osc99_body}"
fi

# Write to the controlling terminal device. /dev/tty is the right path
# essentially everywhere; $TTY is set by some shells (zsh) as a fast path.
target="${TTY:-/dev/tty}"
if ! { printf '%s' "$out" > "$target"; } 2>/dev/null; then
    # Fail loudly so cron-launched / detached invocations don't silently no-op.
    echo "$prog: cannot write to terminal at $target" >&2
    exit 1
fi
