#!/usr/bin/env bash
#
# CardVault — native installer and management console (no Docker).
#
#   First run:  bash scripts/install.sh
#   Later:      sudo cardvault-setup        (or bash scripts/install.sh again)
#
# Supports Debian/Ubuntu, Fedora/RHEL-family and Arch Linux with systemd.
# Environment overrides:
#   CARDVAULT_REPO, CARDVAULT_BRANCH, CARDVAULT_DIR, CARDVAULT_PORT,
#   CARDVAULT_USER, CARDVAULT_EDITOR, NO_COLOR
#

set -Eeuo pipefail
shopt -s nullglob

# ---------------------------------------------------------------------------
# Display helpers
# ---------------------------------------------------------------------------
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  BLUE=$'\033[34m'; CYAN=$'\033[36m'; WHITE=$'\033[97m'
  INVERSE=$'\033[7m'; INVERSE_OFF=$'\033[27m'
  CUR_HIDE=$'\033[?25l'; CUR_SHOW=$'\033[?25h'
else
  BOLD=''; DIM=''; RESET=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; WHITE=''
  INVERSE=''; INVERSE_OFF=''; CUR_HIDE=''; CUR_SHOW=''
fi

# ---------------------------------------------------------------------------
# Console layout: the last terminal row is reserved for the overall status bar
# (plain streaming mode only — the TUI screens below own the whole screen).
# A scroll region keeps every other message above it, so text can never paint
# over the bar and the bar can never paint over text.
# ---------------------------------------------------------------------------
TTY_DEV=''
TERM_ROWS=0
TERM_COLS=0
CONTENT_ROWS=0
STATUS_ROW=0
TERMINAL_UI=0
TUI_MODE=''          # '' (streaming) | dialog | progress
CURRENT_STEP='Idle'
CURRENT_TASK=''

draw_status() {
  (( TERMINAL_UI )) || return 0
  [[ -z $TUI_MODE ]] || return 0
  local pct=0 text=${CURRENT_STEP:-Idle} max
  (( STEP_TOTAL > 0 )) && pct=$(( STEP_NO * 100 / STEP_TOTAL ))
  if [[ -n ${CURRENT_TASK:-} ]]; then text="${CURRENT_STEP} › ${CURRENT_TASK}"; fi
  max=$(( TERM_COLS - 50 )); (( max < 8 )) && max=8
  text=${text:0:$max}
  # ESC 7 / ESC 8 (DECSC/DECRC) save and restore the cursor on every terminal;
  # the CSI s / CSI u pair is ignored by many, leaving output on the status row.
  printf '\0337\033[%d;1H\033[2K' "$STATUS_ROW" >"$TTY_DEV"
  printf ' %s[%d/%d]%s ' "$CYAN" "$STEP_NO" "$STEP_TOTAL" "$RESET" >"$TTY_DEV"
  { pip_bar "$pct" 24; } >"$TTY_DEV"
  printf ' %s%s%s' "$BOLD" "$text" "$RESET" >"$TTY_DEV"
  printf '\0338' >"$TTY_DEV"
}

init_console() {
  [[ -t 0 && -t 1 && -n ${TERM:-} && ${TERM:-dumb} != dumb ]] || return 0
  [[ -e /dev/tty ]] || return 0
  [[ -z ${NO_COLOR:-} ]] || return 0   # NO_COLOR → plain streaming output only
  local size='' rows='' cols=''
  size=$(stty size </dev/tty 2>/dev/null || true)
  if [[ -z $size ]]; then
    rows=$(tput lines 2>/dev/null || true); cols=$(tput cols 2>/dev/null || true)
    size="${rows:-24} ${cols:-100}"
  fi
  rows=${size%% *}; cols=${size##* }
  [[ $rows =~ ^[0-9]+$ ]] || rows=24
  [[ $cols =~ ^[0-9]+$ ]] || cols=100
  (( rows >= 10 )) || return 0

  TTY_DEV=/dev/tty
  TERM_ROWS=$rows
  TERM_COLS=$cols
  STATUS_ROW=$rows
  CONTENT_ROWS=$(( rows - 1 ))
  TERMINAL_UI=1
  if [[ -z $TUI_MODE ]]; then
    printf '\033[1;%dr' "$CONTENT_ROWS" >"$TTY_DEV"
    printf '\033[H\033[2J' >"$TTY_DEV"
    draw_status
  fi
}

clear_content() {
  if (( TERMINAL_UI )); then
    local i
    printf '\033[1;%dr' "$CONTENT_ROWS" >"$TTY_DEV"
    for (( i = 1; i <= CONTENT_ROWS; i++ )); do
      printf '\033[%d;1H\033[2K' "$i" >"$TTY_DEV"
    done
    printf '\033[1;1H' >"$TTY_DEV"
    draw_status
  else
    clear 2>/dev/null || true
  fi
}

cleanup_console() {
  if (( TERMINAL_UI )); then
    tui_screen_close 2>/dev/null || true
    printf '\033[r\033[%d;1H' "$TERM_ROWS" >"$TTY_DEV"
    printf '%s' "$CUR_SHOW" >"$TTY_DEV"
  fi
}

ok()   { if [[ $TUI_MODE == progress ]]; then tui_log ok "$*"; else printf '  %s✔%s %s\n' "$GREEN" "$RESET" "$*"; fi; }
info() { if [[ $TUI_MODE == progress ]]; then tui_log info "$*"; else printf '  %s•%s %s\n' "$CYAN" "$RESET" "$*"; fi; }
warn() { if [[ $TUI_MODE == progress ]]; then tui_log warn "$*"; else printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; fi; }
err()  { if [[ $TUI_MODE == progress ]]; then tui_log err "$*"; else printf '  %s✖%s %s\n' "$RED" "$RESET" "$*" >&2; fi; }
die()  { err "$*"; exit 1; }

section() {
  if [[ $TUI_MODE == progress ]]; then tui_log heading "$*"; return; fi
  printf '\n%s%s━━ %s ━━%s\n' "$BOLD" "$BLUE" "$*" "$RESET"
}

RUN_LOG=${CARDVAULT_LOG:-/tmp/cardvault-setup.log}
STEP_NO=0
STEP_TOTAL=8
BAR_WIDTH=28

# ---------------------------------------------------------------------------
# pip-style progress bar — the look of a pip download:
#   ━━━━━━━━━━━╸━━━━━━━━━  55%  230.5/619.9 MB  3.7 MB/s  eta 0:01:45
# ---------------------------------------------------------------------------
pip_bar() {
  local pct=${1:-0} width=${2:-$BAR_WIDTH}
  (( pct < 0 )) && pct=0
  (( pct > 100 )) && pct=100
  local eighths=$(( pct * width * 8 / 100 ))
  local full=$(( eighths / 8 )) head=$(( eighths % 8 )) i
  (( full >= width )) && { full=$width; head=0; }
  printf '%s' "$CYAN"
  for (( i = 0; i < full; i++ )); do printf '━'; done
  if (( head > 0 && full < width )); then
    if (( head >= 6 )); then printf '%s━' "$WHITE"; else printf '%s╸' "$WHITE"; fi
    full=$(( full + 1 ))
  fi
  printf '%s' "$DIM"
  for (( i = 0; i < width - full; i++ )); do printf '━'; done
  printf '%s' "$RESET"
}

# "eta 0:01:45" — the same shape pip prints.
fmt_eta() {
  local s=${1:-0}
  (( s < 0 )) && s=0
  printf 'eta %d:%02d:%02d' "$(( s / 3600 ))" "$(( (s % 3600) / 60 ))" "$(( s % 60 ))"
}

# "230.5 MB" — pip's short byte units.
fmt_bytes() {
  local b=${1:-0}
  if (( b >= 1073741824 )); then awk -v b="$b" 'BEGIN{printf "%.1f GB", b/1073741824}'
  elif (( b >= 1048576 )); then awk -v b="$b" 'BEGIN{printf "%.1f MB", b/1048576}'
  elif (( b >= 1024 )); then awk -v b="$b" 'BEGIN{printf "%.1f kB", b/1024}'
  else printf '%d B' "$b"; fi
}

# ---------------------------------------------------------------------------
# TUI — Subiquity-style screens (the Ubuntu Server installer look):
# black screen, grey framed dialogs with the title in the top border,
# inverse-highlighted selections and buttons, dim footer hints.
# Pure bash + ANSI; reads keys from /dev/tty, paints to /dev/tty.
# ---------------------------------------------------------------------------

tui_write() { printf '%s' "$*" >"$TTY_DEV"; }
tui_at()    { printf '\033[%d;%dH' "$1" "$2" >"$TTY_DEV"; }

tui_measure() {
  local size rows cols
  size=$(stty size </dev/tty 2>/dev/null || true)
  rows=${size%% *}; cols=${size##* }
  [[ $rows =~ ^[0-9]+$ ]] && (( rows >= 10 )) || rows=24
  [[ $cols =~ ^[0-9]+$ ]] && (( cols >= 40 )) || cols=80
  TERM_ROWS=$rows; TERM_COLS=$cols
}

tui_screen_open() {
  # dialogs over the progress screen just repaint; otherwise use the
  # alternate screen so streamed output in the scrollback is preserved
  [[ $TUI_MODE == progress ]] && return 0
  TUI_MODE=dialog
  printf '\033[?1049h\033[r' >"$TTY_DEV"
  printf '%s' "$CUR_HIDE" >"$TTY_DEV"
}

tui_screen_close() {
  if [[ $TUI_MODE == dialog ]]; then
    TUI_MODE=''
    printf '%s\033[?1049l' "$CUR_SHOW" >"$TTY_DEV"
  elif [[ $TUI_MODE == progress ]]; then
    tui_progress_paint   # a dialog closed over the progress screen — repaint it
  fi
}

tui_chrome() { # $1 = footer hints
  tui_measure
  tui_write $'\033[H\033[2J\033[0m'
  tui_at 1 1
  printf ' %s%sCardVault%s' "$BOLD" "$WHITE" "$RESET" >"$TTY_DEV"
  tui_at 1 $(( TERM_COLS - 24 ))
  printf '%s%-24s%s' "$DIM" "$(fit_text " $(hostname 2>/dev/null || echo local) " 24)" "$RESET" >"$TTY_DEV"
  tui_at 2 1
  printf '%s' "$DIM" >"$TTY_DEV"
  local i; for (( i = 0; i < TERM_COLS; i++ )); do printf '─'; done >"$TTY_DEV"
  printf '%s' "$RESET" >"$TTY_DEV"
  tui_at "$TERM_ROWS" 1
  printf '%s %s%s' "$DIM" "$(fit_text "${1:-}" $(( TERM_COLS - 2 )))" "$RESET" >"$TTY_DEV"
}

# tui_box <row> <col> <w> <h> <title>
tui_box() {
  local r=$1 c=$2 w=$3 h=$4 title=$5 i
  tui_at "$r" "$c"
  printf '%s┌─ %s %s┐%s' "$WHITE" "$BOLD$WHITE$(fit_text " $title " $(( w - 4 )))" "$RESET$WHITE$(printf '─%.0s' $(seq 1 $(( w - 5 - ${#title} - 2 )) 2>/dev/null || echo 0))" "$RESET" >"$TTY_DEV"
  for (( i = 1; i < h - 1; i++ )); do
    tui_at $(( r + i )) "$c"
    printf '%s│%s' "$WHITE" "$RESET" >"$TTY_DEV"
    tui_at $(( r + i )) $(( c + w - 1 ))
    printf '%s│%s' "$WHITE" "$RESET" >"$TTY_DEV"
  done
  tui_at $(( r + h - 1 )) "$c"
  printf '%s└%s┘%s' "$WHITE" "$(printf '─%.0s' $(seq 1 $(( w - 2 )) 2>/dev/null || echo 0))" "$RESET" >"$TTY_DEV"
}

# One key press from the TTY: up down left right enter esc tab backspace
# char:<c> pgup pgdn home end. Arrows arrive as ESC [ A..D.
tui_key() {
  local k rest
  IFS= read -rsn1 k <"$TTY_DEV" || { printf 'esc'; return; }
  case $k in
    '') printf 'enter' ;;
    $'\e')
      IFS= read -rsn2 -t 0.1 rest <"$TTY_DEV" || { printf 'esc'; return; }
      case $rest in
        '[A'|'OA') printf 'up' ;;
        '[B'|'OB') printf 'down' ;;
        '[C'|'OC') printf 'right' ;;
        '[D'|'OD') printf 'left' ;;
        '[H'|'OH') printf 'home' ;;
        '[F'|'OF') printf 'end' ;;
        '[5~') printf 'pgup' ;;
        '[6~') printf 'pgdn' ;;
        '[Z') printf 'shifttab' ;;
        *) printf 'esc' ;;
      esac ;;
    $'\t') printf 'tab' ;;
    $'\x7f'|$'\b') printf 'backspace' ;;
    *) printf 'char:%s' "$k" ;;
  esac
}

# tui_button_row <row> <col> <focused index> label...
tui_button_row() {
  local r=$1 c=$2 focus=$3 i=0 out=''
  shift 3
  for label in "$@"; do
    if (( i == focus )); then out+="${INVERSE}${BOLD} ${label} ${RESET}  "
    else out+="${DIM}[ ${label} ]${RESET}  "; fi
    i=$(( i + 1 ))
  done
  tui_at "$r" "$c"
  printf '%s' "$out" >"$TTY_DEV"
}

# tui_menu <title> <default index> <item>...   items: "label|hint"
# Lines starting with '=' are info rows (not selectable). Prints the chosen
# index (0-based). Esc/q → return 1. Enter/→ on [Select].
tui_menu() {
  local title=$1 def=$2; shift 2
  local -a items=("$@") n=${#@}
  (( n > 0 )) || return 1
  local sel=$(( def < 0 ? 0 : def )) top=0 focus_btn=0 key
  local w h rows vis row i label hint line
  # start on the first selectable row
  for (( i = 0; i < n; i++ )); do [[ ${items[$i]} == '='* ]] || { sel=$i; break; }; done
  if (( def >= 0 && def < n )) && [[ ${items[$def]} != '='* ]]; then sel=$def; fi
  tui_screen_open
  while true; do
    tui_measure
    w=$(( TERM_COLS - 6 )); (( w > 86 )) && w=86
    rows=$(( n + 2 ))          # one blank under the title + button row
    h=$(( rows + 4 )); (( h > TERM_ROWS - 3 )) && h=$(( TERM_ROWS - 3 ))
    vis=$(( h - 5 ))
    (( sel < top )) && top=$sel
    (( sel >= top + vis )) && top=$(( sel - vis + 1 ))
    tui_chrome "$(printf '↑/↓ move • Enter select • Esc back')"
    local boxr=$(( (TERM_ROWS - h) / 2 + 1 )); (( boxr < 3 )) && boxr=3
    local boxc=$(( (TERM_COLS - w) / 2 + 1 ))
    tui_box "$boxr" "$boxc" "$w" "$h" "$title"
    for (( i = 0; i < vis && top + i < n; i++ )); do
      row=$(( boxr + 2 + i ))
      label=${items[$(( top + i ))]%%|*}
      hint=${items[$(( top + i ))]#*|}
      [[ ${items[$(( top + i ))]} == *'|'* ]] || hint=''
      if [[ $label == '='* ]]; then
        tui_at "$row" "$boxc"
        printf ' %s%s%s' "$DIM" "$(fit_text "${label#=}" $(( w - 2 )) | sed 's/\x1b\[[0-9;]*m//g')" "$RESET" >"$TTY_DEV"
        continue
      fi
      line=$(fit_text "  $label" $(( w / 2 )))
      [[ -n $hint ]] && line+="$(printf '%*s' $(( w - 2 - ${#line} - ${#hint} - 2 )) '')${DIM}${hint}${RESET}"
      tui_at "$row" "$boxc"
      if (( top + i == sel )); then
        printf '%s%s%s' "$INVERSE$BOLD" "$(fit_text "▸ $label$( [[ -n $hint ]] && printf '  %s' "$hint")" $(( w - 2 )) | sed 's/\x1b\[[0-9;]*m//g')" "$RESET" >"$TTY_DEV"
      else
        printf ' %s%s' "$(fit_text "$label$( [[ -n $hint ]] && printf '  %s' "$hint")" $(( w - 2 )) | sed 's/\x1b\[[0-9;]*m//g')" "$RESET" >"$TTY_DEV"
      fi
    done
    tui_button_row $(( boxr + h - 2 )) $(( boxc + w - 18 )) "$focus_btn" 'Select' 'Exit'
    key=$(tui_key)
    case $key in
      up|down|home|end|pgup|pgdn)
        case $key in
          up) sel=$(( (sel + n - 1) % n )) ;;
          down) sel=$(( (sel + 1) % n )) ;;
          home)
            sel=0
            for (( i = 0; i < n; i++ )); do [[ ${items[$i]} == '='* ]] || { sel=$i; break; }; done ;;
          end) sel=$(( n - 1 )) ;;
          pgup) sel=$(( sel - vis > 0 ? sel - vis : 0 )) ;;
          pgdn) sel=$(( sel + vis < n - 1 ? sel + vis : n - 1 )) ;;
        esac
        # skip info rows
        local guard=0
        while (( guard < n )) && [[ ${items[$sel]} == '='* ]]; do
          if [[ $key == up || $key == pgup ]]; then sel=$(( (sel + n - 1) % n )); else sel=$(( (sel + 1) % n )); fi
          guard=$(( guard + 1 ))
        done
        ;;
      left|shifttab|tab|right) focus_btn=$(( 1 - focus_btn )) ;;
      enter)
        if (( focus_btn == 1 )); then tui_screen_close; return 1; fi
        [[ ${items[$sel]} == '='* ]] && continue
        tui_screen_close; printf '%s' "$sel"; return 0 ;;
      char:q) tui_screen_close; return 1 ;;
      esc) tui_screen_close; return 1 ;;
    esac
  done
}

# tui_pick <title> <default> <item>...   — same as tui_menu; alias kept for
# pickers (backups, users) where "menu" reads oddly in the code.
tui_pick() { tui_menu "$@"; }

# tui_textview <title> <text>  — scrollable report with [Close].
tui_textview() {
  local title=$1 text=$2 key
  local -a lines=()
  mapfile -t lines <<<"$text"
  local n=${#lines[@]} top=0
  tui_screen_open
  while true; do
    tui_measure
    local w h vis row i boxr boxc
    w=$(( TERM_COLS - 6 )); (( w > 100 )) && w=100
    h=$(( TERM_ROWS - 6 )); (( h > n + 3 )) && h=$(( n + 3 )); (( h < 7 )) && h=7
    vis=$(( h - 4 ))
    (( top + vis > n )) && top=$(( n - vis )); (( top < 0 )) && top=0
    tui_chrome "$(printf '↑/↓ PgUp/PgDn scroll • Enter/Esc close')"
    boxr=$(( (TERM_ROWS - h) / 2 + 1 )); (( boxr < 3 )) && boxr=3
    boxc=$(( (TERM_COLS - w) / 2 + 1 ))
    tui_box "$boxr" "$boxc" "$w" "$h" "$title"
    for (( i = 0; i < vis; i++ )); do
      row=$(( boxr + 2 + i ))
      tui_at "$row" "$boxc"
      printf ' %s' "$(fit_text "${lines[$(( top + i ))]:-}" $(( w - 4 )) | sed 's/\x1b\[[0-9;]*m//g')" >"$TTY_DEV"
    done
    if (( n > vis )); then
      tui_at $(( boxr + 2 )) $(( boxc + w - 2 ))
      printf '%s≡%s' "$DIM" "$RESET" >"$TTY_DEV"
    fi
    tui_button_row $(( boxr + h - 2 )) $(( boxc + w / 2 - 5 )) 0 'Close'
    key=$(tui_key)
    case $key in
      up|char:k) (( top > 0 )) && top=$(( top - 1 )) ;;
      down|char:j) (( top + vis < n )) && top=$(( top + 1 )) ;;
      pgup) top=$(( top - vis > 0 ? top - vis : 0 )) ;;
      pgdn) top=$(( top + vis < n - 1 ? top + vis : n - 1 )) ;;
      home) top=0 ;;
      end) top=$(( n - vis > 0 ? n - vis : 0 )) ;;
      enter|esc|char:q) tui_screen_close; return 0 ;;
    esac
  done
}

# tui_confirm <title> <question> <default y|n>  → 0 yes / 1 no
tui_confirm() {
  local title=$1 question=$2 def=${3:-y} key
  local btn=1
  [[ $def == y ]] && btn=0
  tui_screen_open
  while true; do
    tui_measure
    local w=60 h=8 boxr boxc
    (( w > TERM_COLS - 6 )) && w=$(( TERM_COLS - 6 ))
    tui_chrome "$(printf '←/→ choose • Enter confirm • Esc cancel')"
    boxr=$(( (TERM_ROWS - h) / 2 + 1 )); (( boxr < 3 )) && boxr=3
    boxc=$(( (TERM_COLS - w) / 2 + 1 ))
    tui_box "$boxr" "$boxc" "$w" "$h" "$title"
    tui_at $(( boxr + 2 )) "$boxc"
    printf ' %s' "$(fit_text "$question" $(( w - 4 )) | sed 's/\x1b\[[0-9;]*m//g')" >"$TTY_DEV"
    tui_button_row $(( boxr + h - 2 )) $(( boxc + w / 2 - 10 )) "$btn" 'Yes' 'No'
    key=$(tui_key)
    case $key in
      left|right|tab|shifttab) btn=$(( 1 - btn )) ;;
      enter)
        tui_screen_close
        (( btn == 0 )) && return 0 || return 1 ;;
      esc|char:q|char:n|char:N) tui_screen_close; return 1 ;;
      char:y|char:Y) tui_screen_close; return 0 ;;
    esac
  done
}

# tui_input <title> <prompt> <default> <secret?>  → echoes the value
# Esc closes and returns 1 (callers fall back to the default).
tui_input() {
  local title=$1 prompt=$2 value=${3:-} secret=${4:-} key
  tui_screen_open
  while true; do
    tui_measure
    local w=64 h=8 boxr boxc shown
    (( w > TERM_COLS - 6 )) && w=$(( TERM_COLS - 6 ))
    if [[ $secret == secret ]]; then shown=$(printf '•%.0s' $(seq 1 ${#value} 2>/dev/null || echo 0)); else shown=$value; fi
    tui_chrome "$(printf 'Type to edit • Enter confirm • Esc cancel')"
    boxr=$(( (TERM_ROWS - h) / 2 + 1 )); (( boxr < 3 )) && boxr=3
    boxc=$(( (TERM_COLS - w) / 2 + 1 ))
    tui_box "$boxr" "$boxc" "$w" "$h" "$title"
    tui_at $(( boxr + 2 )) "$boxc"
    printf ' %s' "$(fit_text "$prompt" $(( w - 4 )) | sed 's/\x1b\[[0-9;]*m//g')" >"$TTY_DEV"
    tui_at $(( boxr + 4 )) $(( boxc + 2 ))
    printf '%s> %s%s▌%s' "$DIM" "$RESET" "$(fit_text "$shown" $(( w - 8 )))" "$RESET" >"$TTY_DEV"
    tui_button_row $(( boxr + h - 2 )) $(( boxc + w - 16 )) 0 'OK'
    key=$(tui_key)
    case $key in
      enter) tui_screen_close; printf '%s' "$value"; return 0 ;;
      esc|char:q) tui_screen_close; return 1 ;;
      backspace) value=${value%?} ;;
      char:*) value+="${key#char:}" ;;
    esac
  done
}

# ---- progress screen (the installer look while actions run) ----------------
TUI_LOG_LINES=()
TUI_PCT=0
TUI_ETA=0

tui_log() { # kind text — appended to the checklist and repainted
  TUI_LOG_LINES+=("$1|$2")
  (( ${#TUI_LOG_LINES[@]} > 400 )) && TUI_LOG_LINES=("${TUI_LOG_LINES[@]: -300}")
  tui_progress_paint
}

tui_progress_open() { # title
  TUI_MODE=progress
  TUI_PROG_DEPTH=$(( ${TUI_PROG_DEPTH:-0} + 1 ))
  TUI_LOG_LINES=()
  TUI_PCT=0
  CURRENT_TASK=''
  printf '\033[?1049h\033[r' >"$TTY_DEV"
  printf '%s' "$CUR_HIDE" >"$TTY_DEV"
  tui_progress_paint "$1"
}

tui_progress_paint() { # optional title override (kept in a global)
  [[ $TUI_MODE == progress ]] || return 0
  local title=${1:-${TUI_PROGRESS_TITLE:-Working}}
  TUI_PROGRESS_TITLE=$title
  tui_measure
  local w h boxr boxc i row vis n
  w=$(( TERM_COLS - 6 )); (( w > 92 )) && w=92
  h=$(( TERM_ROWS - 4 )); (( h > 26 )) && h=26
  boxr=$(( (TERM_ROWS - h) / 2 + 1 )); (( boxr < 2 )) && boxr=2
  boxc=$(( (TERM_COLS - w) / 2 + 1 ))
  tui_chrome "$(printf 'Details: %s' "${RUN_LOG}")"
  tui_box "$boxr" "$boxc" "$w" "$h" "$title"
  n=${#TUI_LOG_LINES[@]}
  vis=$(( h - 6 ))
  for (( i = 0; i < vis; i++ )); do
    row=$(( boxr + 2 + i ))
    tui_at "$row" "$boxc"
    local idx=$(( n - vis + i )) entry=''
    (( idx >= 0 && idx < n )) && entry=${TUI_LOG_LINES[$idx]}
    if [[ -z $entry ]]; then printf '%*s' $(( w - 2 )) '' >"$TTY_DEV"; continue; fi
    local kind=${entry%%|*} text=${entry#*|} mark=$DIM
    case $kind in
      ok) mark=$GREEN; text="✔ $text" ;;
      warn) mark=$YELLOW; text="! $text" ;;
      err) mark=$RED; text="✖ $text" ;;
      heading) mark="$BOLD$WHITE"; text="━━ $text" ;;
      info) mark=$CYAN; text="• $text" ;;
    esac
    printf ' %s%s%s' "$mark" "$(fit_text "$text" $(( w - 4 )) | sed 's/\x1b\[[0-9;]*m//g')" "$RESET" >"$TTY_DEV"
  done
  # current task + pip bar + eta, exactly where pip puts its download line
  row=$(( boxr + h - 3 ))
  tui_at "$row" "$boxc"
  printf ' %s' "$(fit_text "${CURRENT_TASK:-Working…}" $(( w - 4 )) | sed 's/\x1b\[[0-9;]*m//g')" >"$TTY_DEV"
  row=$(( boxr + h - 2 ))
  local bar_w=$(( w - 30 )); (( bar_w > 40 )) && bar_w=40
  tui_at "$row" $(( boxc + 2 ))
  { pip_bar "$TUI_PCT" "$bar_w"; printf ' %3d%%  %s' "$TUI_PCT" "$(fmt_eta "$TUI_ETA")"; } >"$TTY_DEV"
}

tui_progress_close() {
  [[ $TUI_MODE == progress ]] || return 0
  TUI_PROG_DEPTH=$(( ${TUI_PROG_DEPTH:-1} - 1 ))
  (( TUI_PROG_DEPTH > 0 )) && return 0
  TUI_MODE=''
  printf '%s\033[?1049l' "$CUR_SHOW" >"$TTY_DEV"
}

# tui_action <title> <fn> [args…] — run a mutating flow on the progress
# screen (checklist + pip bar), or with plain streaming output when the TUI
# is off. One "press Enter" at the end, in both modes.
tui_action() {
  local title=$1; shift
  if (( TERMINAL_UI )) && [[ ${CARDVAULT_VERBOSE:-0} != 1 ]]; then
    tui_progress_open "$title"
    # The flow's raw output goes to the run log; ok/err/warn feed the
    # checklist on screen. Prompts (ask/prompt_value/…) draw dialogs over
    # the progress screen and return their answers normally.
    "$@" >>"$RUN_LOG" 2>&1
    wrap_pause
    tui_progress_close
    return
  fi
  section "$title"
  "$@"
  wrap_pause
}

# tui_report <title> <fn> [args…] — read-only output as a scrollable dialog.
tui_report() {
  local title=$1; shift
  if (( TERMINAL_UI )) && [[ ${CARDVAULT_VERBOSE:-0} != 1 ]]; then
    local out prev=$TUI_MODE
    TUI_MODE=''                 # capture as plain text, not as checklist lines
    TUI_CAPTURING=1             # interactive primitives must not block here
    out=$("$@" 2>&1 || true)
    TUI_CAPTURING=0
    TUI_MODE=$prev
    tui_textview "$title" "$out"
    return
  fi
  section "$title"
  "$@"
  wrap_pause
}

# tui_external <title> <fn> — the flow owns the terminal (editor, log tail):
# leave the TUI first, come back after.
tui_external() {
  local title=$1; shift
  tui_progress_close; tui_screen_close
  section "$title"
  "$@"
  wrap_pause
}

# pick_from <title> <prompt> <item>...  — prints the 1-based choice (0 = cancel).
# TUI: a selection dialog. Plain: the numbered list + prompt_value.
pick_from() {
  local title=$1 prompt=$2; shift 2
  if (( TERMINAL_UI )) && [[ ${CARDVAULT_VERBOSE:-0} != 1 ]]; then
    local i
    if i=$(tui_pick "$title" 0 "$@"); then
      printf '%s' $(( i + 1 ))
    else
      printf '0'
    fi
    return 0
  fi
  local i=1 f
  for f in "$@"; do printf '  %s[%d]%s %s\n' "$CYAN" "$i" "$RESET" "$f"; i=$(( i + 1 )); done
  prompt_value "$prompt" 1
}

# tui_demo — hidden preview of every TUI screen (--tui-demo). Touches nothing.
tui_demo_report() {
  printf 'This report is captured as plain text.\n'
  ask "A question that must NOT block while captured" y && printf 'default answer used\n'
  printf 'prompt_value gave: %s\n' "$(prompt_value 'A prompt that must NOT block' 'default')"
  pause
  printf 'If you can read this, pause did not hang the capture.\n'
}

tui_demo() {
  if [[ ! -t 1 ]]; then
    info "The TUI demo needs an interactive terminal."
    return 0
  fi
  if [[ ${CARDVAULT_VERBOSE:-0} == 1 ]] || (( ! TERMINAL_UI )); then
    # streaming look: step/task/run with the animated pip bar
    STEP_TOTAL=2
    step "Demo streaming step"
    task "Demo task with a long name that gets cut to fit the terminal"
    EXPECTED_SECONDS=2 run "Demo command" sleep 1
    ok "Streaming demo finished."
    return 0
  fi
  local sel
  if sel=$(tui_menu 'CardVault management console' 0 \
      'Service status / URL|what runs, and where to reach CardVault' \
      'Start services|api, worker and web server' \
      'Export database|save a timestamped .dump backup' \
      'LAN access / addresses|firewall, hostname, WEB_ORIGIN' \
      'Wipe and reinstall|destroys all data'); then
    info "You picked item $(( sel + 1 ))."
  else
    info "You pressed Esc."
  fi
  if tui_confirm 'Confirm' 'Demo: continue with the progress screen?' y; then
    info "Confirmed."
  else
    info "Declined."
  fi
  local v
  v=$(tui_input 'CardVault' 'Demo input — type anything, then Enter' 'default text') || v='<cancelled>'
  info "Input was: ${v}"
  tui_textview 'Installation details' "$(printf 'CardVault demo report\n\nThis is a scrollable report — try ↑/↓, PgUp/PgDn, Home/End.\nPress Enter or Esc to close.\n\n%s' "$(seq 1 60 | sed 's/^/  line /')")"
  tui_report 'Captured report' tui_demo_report
  tui_progress_open 'Demo: installing'
  local i
  for i in $(seq 1 20); do
    TUI_PCT=$(( i * 5 ))
    TUI_ETA=$(( (20 - i) ))
    CURRENT_TASK="Downloading package ${i}/20"
    tui_progress_paint
    sleep 0.15
  done
  tui_log ok 'Everything downloaded'
  tui_log warn 'A harmless warning'
  tui_log heading 'Wrapping up'
  tui_progress_close
  info "Demo finished."
  wrap_pause
}

step() {
  STEP_NO=$((STEP_NO + 1))
  local pct=$(( STEP_NO * 100 / STEP_TOTAL ))
  CURRENT_STEP="$*"
  CURRENT_TASK=''
  if [[ $TUI_MODE == progress ]]; then
    TUI_PCT=$pct
    tui_log heading "$*"
    return
  fi
  printf '\n%s[%d/%d]%s %s%s%s\n' "$CYAN" "$STEP_NO" "$STEP_TOTAL" "$RESET" "$BOLD" "$*" "$RESET"
  if (( TERMINAL_UI )); then
    draw_status
  else
    printf '  %sOverall%s ' "$DIM" "$RESET"
    pip_bar "$pct" 28
    printf ' %3d%%\n' "$pct"
  fi
}

task() {
  CURRENT_TASK="$*"
  if [[ $TUI_MODE == progress ]]; then
    tui_progress_paint
    return
  fi
  draw_status
  printf '    %s↳%s %s\n' "$DIM" "$RESET" "$(fit_text "$*" $(( $(term_cols) - 7 )))"
}

# Width of the terminal, for fitting single-line output.
term_cols() {
  local c=${TERM_COLS:-0}
  (( c > 0 )) || c=$(tput cols 2>/dev/null || echo 80)
  [[ $c =~ ^[0-9]+$ ]] && (( c >= 20 )) || c=80
  printf '%s' "$c"
}

# Shorten text to at most $2 characters, ending in "…" when cut.
fit_text() {
  local text=$1 max=$2
  (( max < 1 )) && { printf ''; return; }
  if (( ${#text} > max )); then printf '%s…' "${text:0:$(( max - 1 ))}"; else printf '%s' "$text"; fi
}

# Runs a task with an animated progress bar. Set EXPECTED_SECONDS before calling
# to make the bar fill at a realistic pace; it holds at 95% if a task runs long.
# Interactive terminals get ONE line per task: "→ label [bar] pct time" updated in
# place, then replaced by "✔ label (Ns)" or "✖ label failed". The line is sized to
# the terminal so it can never wrap (a wrapped line can't be fully erased).
run() {
  local label=$1 expected=${EXPECTED_SECONDS:-30} start=$SECONDS pid rc=0
  shift
  (( expected > 0 )) || expected=30
  CURRENT_TASK="$label"
  draw_status
  if [[ ${CARDVAULT_VERBOSE:-0} == 1 ]]; then
    printf '  %s→%s %s\n' "$DIM" "$RESET" "$label"
    set +e
    "$@" 2>&1 | tee -a "$RUN_LOG"
    rc=${PIPESTATUS[0]}
    set -e
  elif [[ $TUI_MODE == progress ]]; then
    "$@" >>"$RUN_LOG" 2>&1 &
    pid=$!
    local elapsed pct
    while kill -0 "$pid" 2>/dev/null; do
      elapsed=$(( SECONDS - start ))
      pct=$(( elapsed * 100 / expected ))
      (( pct > 95 )) && pct=95
      TUI_PCT=$pct
      TUI_ETA=$(( expected > elapsed ? expected - elapsed : 0 ))
      tui_progress_paint
      sleep 0.2
    done
    if wait "$pid"; then rc=0; else rc=$?; fi
    TUI_PCT=0; TUI_ETA=0
  elif [[ -t 1 ]]; then
    local cols bar_w label_w shown elapsed pct
    cols=$(term_cols)
    # "  ↓ " + label + " " + bar + " 100%  eta 0:00:00" (+1 spare column)
    bar_w=$(( cols - 4 - 1 - 2 - 12 - 1 - 26 ))
    (( bar_w > 28 )) && bar_w=28
    (( bar_w < 8 )) && bar_w=0
    label_w=$(( cols - 4 - 14 - 1 - ( bar_w > 0 ? bar_w + 2 : 0 ) ))
    shown=$(fit_text "$label" "$label_w")
    "$@" >>"$RUN_LOG" 2>&1 &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      elapsed=$(( SECONDS - start ))
      pct=$(( elapsed * 100 / expected ))
      (( pct > 95 )) && pct=95
      printf '\r\033[2K  %s↓%s %s ' "$DIM" "$RESET" "$shown"
      (( bar_w > 0 )) && pip_bar "$pct" "$bar_w"
      printf ' %3d%%  %s' "$pct" "$(fmt_eta $(( expected > elapsed ? expected - elapsed : 0 )))"
      sleep 0.2
    done
    if wait "$pid"; then rc=0; else rc=$?; fi
    printf '\r\033[2K'
  else
    # not a terminal (piped / logged): plain lines, no animation
    printf '  → %s\n' "$label"
    "$@" >>"$RUN_LOG" 2>&1 || rc=$?
  fi
  CURRENT_TASK=''
  draw_status
  if (( rc == 0 )); then
    ok "$label  ${DIM}($(( SECONDS - start ))s)${RESET}"
  else
    err "$label failed (exit ${rc})"
    if [[ -s $RUN_LOG ]]; then
      if [[ $TUI_MODE == progress ]]; then
        tui_log info "Last log lines are in ${RUN_LOG}"
      else
        printf '  %sLast log lines:%s\n' "$DIM" "$RESET" >&2
        tail -n 15 "$RUN_LOG" >&2
      fi
    fi
    return "$rc"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

ask() {
  local prompt=$1 default=${2:-y} ans
  if [[ ${TUI_CAPTURING:-0} == 1 ]]; then [[ $default == y ]]; return; fi
  if [[ ! -t 0 ]]; then printf '%s\n' "$prompt (non-interactive: using default)" >&2; [[ $default == y ]]; return; fi
  if (( TERMINAL_UI )); then
    tui_confirm 'Confirm' "$prompt" "$default"
    return
  fi
  if [[ $default == y ]]; then printf '  %s?%s %s %s[Y/n]%s ' "$BLUE" "$RESET" "$prompt" "$BOLD" "$RESET" >&2
  else printf '  %s?%s %s %s[y/N]%s ' "$BLUE" "$RESET" "$prompt" "$BOLD" "$RESET" >&2; fi
  read -r ans || ans=''
  case "${ans,,}" in
    y|yes) return 0 ;;
    n|no)  return 1 ;;
    '')    [[ $default == y ]] ;;
    *)     warn "Please answer yes or no."; ask "$prompt" "$default" ;;
  esac
}

prompt_value() {
  local prompt=$1 default=${2:-} out
  if [[ ${TUI_CAPTURING:-0} == 1 ]]; then printf '%s' "$default"; return; fi
  if [[ ! -t 0 ]]; then printf '%s\n' "$prompt (non-interactive: using default)" >&2; printf '%s' "$default"; return; fi
  if (( TERMINAL_UI )); then
    out=$(tui_input 'CardVault' "$prompt" "$default") || out=$default
    printf '%s' "${out:-$default}"
    return
  fi
  if [[ -n $default ]]; then printf '  %s?%s %s %s[%s]%s ' "$BLUE" "$RESET" "$prompt" "$DIM" "$default" "$RESET" >&2
  else printf '  %s?%s %s ' "$BLUE" "$RESET" "$prompt" >&2; fi
  IFS= read -r out || true
  printf '%s' "${out:-$default}"
}

prompt_secret() {
  local prompt=$1 out
  if [[ ${TUI_CAPTURING:-0} == 1 ]]; then printf '%s' ''; return; fi
  if [[ ! -t 0 ]]; then printf '%s' ''; return; fi
  if (( TERMINAL_UI )); then
    out=$(tui_input 'Password' "$prompt" '' secret) || out=''
    printf '%s' "$out"
    return
  fi
  printf '  %s?%s %s ' "$BLUE" "$RESET" "$prompt" >&2
  IFS= read -rs out || true
  printf '\n' >&2
  printf '%s' "$out"
}

confirm_type() {
  local word=$1 ans
  if [[ ${TUI_CAPTURING:-0} == 1 ]]; then return 1; fi
  if (( TERMINAL_UI )); then
    ans=$(tui_input 'Confirm' "Type ${word} to confirm" '') || return 1
    [[ $ans == "$word" ]]
    return
  fi
  printf '  Type %s%s%s to confirm: ' "$BOLD" "$word" "$RESET" >&2
  IFS= read -r ans || true
  [[ $ans == "$word" ]]
}

pause() {
  if [[ ${TUI_CAPTURING:-0} == 1 ]]; then return 0; fi
  if [[ ! -t 0 ]]; then return 0; fi
  if [[ $TUI_MODE == progress ]]; then
    tui_at "$TERM_ROWS" 1
    printf '%s Press Enter to continue…%s' "$DIM" "$RESET" >"$TTY_DEV"
    IFS= read -r _ <"$TTY_DEV" || true
    tui_progress_paint
  else
    printf '  %sPress Enter to continue…%s' "$DIM" "$RESET" >&2
    read -r _ || true
  fi
  LAST_PAUSE_US=${EPOCHREALTIME:-0}; LAST_PAUSE_US=${LAST_PAUSE_US/./}
}

# One "press Enter" per menu action: pause when the flow did not just pause
# itself (flows end with pause to let people read their output).
wrap_pause() {
  local now=${EPOCHREALTIME:-0}
  now=${now/./}
  [[ -n ${LAST_PAUSE_US:-} ]] && (( now - LAST_PAUSE_US < 500000 )) && return 0
  pause
}

# ---------------------------------------------------------------------------
# Paths / constants
# ---------------------------------------------------------------------------
CONF_FILE=${CARDVAULT_CONF:-/etc/cardvault-install.conf}
MGR=/usr/local/bin/cardvault-setup
REPO=${CARDVAULT_REPO:-https://github.com/iant89/CardVault.git}
BRANCH_DEFAULT=${CARDVAULT_BRANCH:-main}
SCRIPT_PATH=${BASH_SOURCE[0]:-}
[[ -n $SCRIPT_PATH && -f $SCRIPT_PATH ]] || SCRIPT_PATH=''
SCRIPT_DIR=''
[[ -n $SCRIPT_PATH ]] && SCRIPT_DIR=$(cd "$(dirname "$SCRIPT_PATH")" && pwd)

banner() {
  [[ $TUI_MODE == progress ]] && return 0
  printf '\n%s' "$CYAN"
  cat <<'EOF'
   ██████╗ ██████╗  █████╗ ██╗   ██╗██╗   ██╗███████╗██╗   ██╗███████╗
  ██╔════╝ ██╔══██╗██╔══██╗██║   ██║██║   ██║██╔════╝██║   ██║██╔════╝
  ██║  ███╗██████╔╝███████║██║   ██║██║   ██║█████╗  ██║   ██║███████╗
  ██║   ██║██╔══██╗██╔══██║██║   ██║██║   ██║██╔══╝  ██║   ██║╚════██║
  ╚██████╔╝██║  ██║██║  ██║╚██████╔╝╚██████╔╝███████╗╚██████╔╝███████║
   ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚══════╝ ╚═════╝ ╚══════╝
EOF
  printf '%s\n' "$RESET"
  printf '%s%sNative installer & management console%s\n' "$BOLD" "$WHITE" "$RESET"
  printf '%sLocal network only • PostgreSQL + Redis + nginx + systemd%s\n\n' "$DIM" "$RESET"
}

# ---------------------------------------------------------------------------
# Privilege + platform helpers
# ---------------------------------------------------------------------------
as_root() {
  if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

pg_admin() {
  if [[ $EUID -eq 0 ]]; then runuser -u postgres -- "$@"; else sudo -u postgres "$@"; fi
}

have_systemd() { [[ -d /run/systemd/system ]] && have systemctl; }

detect_os() {
  [[ -f /etc/os-release ]] || die "Unsupported system: /etc/os-release not found (macOS is not supported by this script)."
  # shellcheck disable=SC1091
  . /etc/os-release
  case ${ID:-} in
    debian|ubuntu|linuxmint|raspbian) OS_FAMILY=debian ;;
    fedora|rhel|centos|rocky|almalinux|ol) OS_FAMILY=rhel ;;
    arch|manjaro|endeavouros) OS_FAMILY=arch ;;
    *) die "Unsupported distribution: ${PRETTY_NAME:-${ID:-unknown}}. Supported: Debian/Ubuntu, Fedora/RHEL, Arch." ;;
  esac
  OS_PRETTY=${PRETTY_NAME:-$ID}
}

ensure_sudo() {
  if [[ $EUID -eq 0 ]]; then return; fi
  have sudo || die "sudo is required. Install it, or run this script as root."
  if ! sudo -n true 2>/dev/null; then
    info "Administrator privileges are needed for package and service setup."
    sudo -v || die "Could not obtain sudo privileges."
  fi
}

node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 | grep -E '^[0-9]+$' || echo 0; }

install_packages() {
  section "System dependencies"
  task "Checking which packages are already present"
  case $OS_FAMILY in
    debian)
      task "Refreshing package lists"
      EXPECTED_SECONDS=60 run "Refresh package index" as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
      task "Installing PostgreSQL, Redis, nginx, Node.js prerequisites and build tools"
      EXPECTED_SECONDS=180 run "Install base packages" as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
        curl git ca-certificates openssl nano build-essential python3 postgresql postgresql-contrib postgresql-client redis-server nginx
      if [[ $(node_major) -lt 22 ]]; then
        EXPECTED_SECONDS=45 run "Add NodeSource Node.js 22 repository" bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | '"$( [[ $EUID -eq 0 ]] || echo sudo )"' bash -'
        EXPECTED_SECONDS=90 run "Install Node.js 22" as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
      fi
      ;;
    rhel)
      EXPECTED_SECONDS=180 run "Install base packages" as_root dnf install -y -q curl git ca-certificates openssl nano gcc gcc-c++ make python3 postgresql-server postgresql-contrib redis nginx
      if [[ $(node_major) -lt 22 ]]; then
        EXPECTED_SECONDS=45 run "Add NodeSource Node.js 22 repository" bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | '"$( [[ $EUID -eq 0 ]] || echo sudo )"' bash -'
        EXPECTED_SECONDS=90 run "Install Node.js 22" as_root dnf install -y -q nodejs
      fi
      ;;
    arch)
      EXPECTED_SECONDS=180 run "Install base packages" as_root pacman -Syu --noconfirm curl git ca-certificates openssl nano base-devel python3 npm postgresql redis nginx
      ;;
  esac

  if [[ ${HTTPS_ENABLED:-no} == yes ]]; then
    install_caddy
  fi

  if ! have pnpm || [[ $(pnpm --version 2>/dev/null | cut -d. -f1) -lt 10 ]]; then
    task "Installing the pnpm package manager"
    EXPECTED_SECONDS=60 run "Install pnpm 10" as_root npm install -g pnpm@10.12.1
  fi
  ok "Node $(node -v), pnpm $(pnpm --version), $(pg_config --version 2>/dev/null || echo 'PostgreSQL installed')"
}

install_caddy() {
  have caddy && { ok "Caddy already installed"; return; }
  local sudo_prefix=''
  [[ $EUID -eq 0 ]] || sudo_prefix=sudo
  task "Installing Caddy (reverse proxy with local CA)"
  case $OS_FAMILY in
    debian)
      EXPECTED_SECONDS=90 run "Add Caddy repository" bash -c "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/setup.deb.sh | ${sudo_prefix} bash -"
      EXPECTED_SECONDS=90 run "Install Caddy" as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy
      ;;
    rhel)
      EXPECTED_SECONDS=90 run "Add Caddy repository" bash -c "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/setup.rpm.sh | ${sudo_prefix} bash -"
      EXPECTED_SECONDS=90 run "Install Caddy" as_root dnf install -y -q caddy
      ;;
    arch)
      EXPECTED_SECONDS=90 run "Install Caddy" as_root pacman -S --noconfirm caddy
      ;;
  esac
  have caddy || die "Caddy could not be installed."
}

ca_source_cert() {
  local p
  for p in /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt \
           /etc/caddy/pki/authorities/local/root.crt \
           /var/lib/caddy/pki/authorities/local/root.crt; do
    if [[ -f $p ]]; then printf '%s' "$p"; return; fi
  done
}

publish_ca_cert() {
  local src='' i=''
  src=$(ca_source_cert)
  if [[ -z $src && -n ${HTTPS_HOST:-} ]]; then
    # Caddy creates the internal CA on first TLS handshake — trigger it locally.
    sleep 1
    have curl && curl -sk --resolve "${HTTPS_HOST}:443:127.0.0.1" "https://${HTTPS_HOST}/" -o /dev/null 2>/dev/null || true
    for i in {1..15}; do
      sleep 1
      src=$(ca_source_cert)
      [[ -n $src ]] && break
    done
  fi
  if [[ -z $src ]]; then
    warn "Caddy's root CA has not been generated yet; run option 18 → 3 again shortly."
    return 1
  fi
  as_root install -d -m 0755 /etc/cardvault/ca
  as_root install -m 0644 "$src" /etc/cardvault/ca/cardvault-ca.crt
  ok "CA download ready: http://${HTTPS_HOST:-cardvault.home}/cardvault-ca.crt"
}

install_https() {
  [[ ${HTTPS_ENABLED:-no} == yes ]] || return 0
  [[ -n ${HTTPS_HOST:-} ]] || HTTPS_HOST=cardvault.home
  task "Writing Caddyfile for ${HTTPS_HOST}"
  local tmp; tmp=$(mktemp)
  # Caddy serves HTTPS (443) only. Port 80 belongs to nginx, which on most
  # distributions already listens there with its stock default site; a Caddy
  # site on :80 made Caddy fail with "bind: address already in use". nginx
  # serves the certificate download and the http→https redirect instead.
  cat >"$tmp" <<EOF
# Generated by cardvault-setup. Local CA certificate, no public exposure needed.
{
    auto_https disable_redirects
}

${HTTPS_HOST} {
    tls internal
    reverse_proxy 127.0.0.1:${WEB_PORT}
}
EOF
  as_root install -d -m 0755 /etc/caddy
  local changed=yes
  if [[ -f /etc/caddy/Caddyfile ]] && cmp -s "$tmp" /etc/caddy/Caddyfile; then changed=no; fi
  as_root install -m 0644 "$tmp" /etc/caddy/Caddyfile
  rm -f "$tmp"
  if have_systemd; then
    as_root systemctl enable caddy >/dev/null 2>&1 || true
    # (re)start when the config changed or Caddy isn't running (e.g. it had failed)
    if [[ $changed == yes ]] || ! systemctl is-active --quiet caddy 2>/dev/null; then
      as_root systemctl restart caddy >/dev/null 2>&1 || warn "Caddy did not start; see: sudo journalctl -u caddy -n 30"
    fi
  fi
  publish_ca_cert || true
  ok "HTTPS configured at https://${HTTPS_HOST}"
}

set_https_env() {
  local enabled=$1 host=${2:-} value
  if [[ $enabled == yes ]]; then
    value="https://${host}"
    sed -i "s|^WEB_ORIGIN=.*|WEB_ORIGIN=${value}|; s|^COOKIE_SECURE=.*|COOKIE_SECURE=true|" "$INSTALL_DIR/.env"
  else
    detect_lan
    value="http://${LAN_HOSTNAME}:${WEB_PORT}"
    sed -i "s|^WEB_ORIGIN=.*|WEB_ORIGIN=${value}|; s|^COOKIE_SECURE=.*|COOKIE_SECURE=false|" "$INSTALL_DIR/.env"
  fi
  ok "WEB_ORIGIN=${value}"
}

https_instructions() {
  section "Trusted certificate on your devices"
  publish_ca_cert || true
  if [[ ! -f /etc/cardvault/ca/cardvault-ca.crt ]]; then
    warn "Root certificate not ready yet. Run option 18 → 3 again shortly."
    return
  fi
  printf '  On each phone/tablet, open this link and install the profile:\n'
  printf '  %shttp://%s/cardvault-ca.crt%s\n' "$CYAN" "${HTTPS_HOST:-cardvault.home}" "$RESET"
  printf '\n'
  printf '  iOS: tap the downloaded .crt → Install Profile → enter passcode.\n'
  printf '       Then Settings → General → About → Certificate Trust Settings\n'
  printf '       → enable full trust for the CardVault local CA.\n'
  printf '  Direct file on the server: %s/etc/cardvault/ca/cardvault-ca.crt%s\n' "$DIM" "$RESET"
  printf '  Then browse %shttps://%s%s and the live camera will work.\n' "$CYAN" "${HTTPS_HOST:-cardvault.home}" "$RESET"
}

configure_postgres() {
  section "PostgreSQL"
  task "Ensuring the PostgreSQL server is running"
  if ! pg_admin psql -tAc 'SELECT 1' >/dev/null 2>&1; then
    if have postgresql-setup; then
      EXPECTED_SECONDS=60 run "Initialise PostgreSQL data directory" as_root postgresql-setup --initdb
    else
      EXPECTED_SECONDS=30 run "Initialise PostgreSQL data directory" as_root install -d -o postgres -g postgres /var/lib/postgresql/data
      EXPECTED_SECONDS=60 run "Run initdb" pg_admin initdb -D /var/lib/postgresql/data
    fi
  fi
  as_root systemctl enable --now postgresql >/dev/null 2>&1 || as_root service postgresql start >/dev/null 2>&1 || true
  sleep 1

  if [[ -z $(pg_admin psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='cardvault'" 2>/dev/null) ]]; then
    task "Creating the cardvault database role"
    EXPECTED_SECONDS=30 run "Create database role 'cardvault'" pg_admin psql -c "CREATE ROLE cardvault LOGIN PASSWORD '${DB_PASS}';"
  else
    task "Updating the cardvault database password"
    EXPECTED_SECONDS=30 run "Update database role password" pg_admin psql -c "ALTER ROLE cardvault WITH LOGIN PASSWORD '${DB_PASS}';"
  fi
  if [[ -z $(pg_admin psql -tAc "SELECT 1 FROM pg_database WHERE datname='cardvault'" 2>/dev/null) ]]; then
    task "Creating the cardvault database"
    EXPECTED_SECONDS=30 run "Create database 'cardvault'" pg_admin createdb -O cardvault cardvault
  fi
  ok "PostgreSQL ready"
}

configure_redis() {
  section "Redis"
  task "Ensuring the Redis server is running"
  local conf=''
  for f in /etc/redis/redis.conf /etc/redis.conf; do [[ -f $f ]] && conf=$f && break; done
  if [[ -n $conf ]]; then
    if ! grep -qE '^[[:space:]]*appendonly[[:space:]]+yes' "$conf"; then
      run "Enable Redis AOF persistence" bash -c "printf '\n# CardVault: keep queued jobs across restarts\nappendonly yes\nappendfsync everysec\n' >> '$conf'"
    fi
  fi
  local svc=redis-server
  systemctl list-unit-files 2>/dev/null | grep -q '^redis.service' && svc=redis
  as_root systemctl enable --now "$svc" >/dev/null 2>&1 || as_root service "$svc" start >/dev/null 2>&1 || true
  ok "Redis ready"
}

# ---------------------------------------------------------------------------
# LAN addressing helpers
# ---------------------------------------------------------------------------
LAN_HOSTNAME=''
LAN_FQDN=''
LAN_IPS=()
PRIMARY_LAN_IP=''

is_private_ip() {
  case ${1:-} in
    10.*|192.168.*) return 0 ;;
  esac
  [[ ${1:-} =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]]
}

detect_lan() {
  LAN_HOSTNAME=$(hostname -s 2>/dev/null || echo cardvault)
  LAN_FQDN=$(hostname -f 2>/dev/null || echo "$LAN_HOSTNAME")
  LAN_IPS=()
  local ip=''
  while IFS= read -r ip; do
    ip=${ip%%/*}
    [[ -n $ip && $ip =~ ^[0-9]+\. ]] && is_private_ip "$ip" && LAN_IPS+=("$ip")
  done < <( (hostname -I 2>/dev/null || true) | tr ' ' '\n')
  if (( ${#LAN_IPS[@]} == 0 )) && have ip; then
    while IFS= read -r ip; do
      ip=${ip%%/*}
      [[ -n $ip ]] && is_private_ip "$ip" && LAN_IPS+=("$ip")
    done < <(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}')
  fi
  PRIMARY_LAN_IP=${LAN_IPS[0]:-}
}

server_names() {
  local names=("$LAN_FQDN" "$LAN_HOSTNAME" "${LAN_IPS[@]}" _)
  printf '%s' "${names[*]}"
}

# ---------------------------------------------------------------------------
# Installed-state helpers
# ---------------------------------------------------------------------------
write_config() {
  local dir=$1 branch=$2 user=$3 port=$4 access=${5:-yes} https=${6:-no} host=${7:-}
  as_root tee "$CONF_FILE" >/dev/null <<EOF
# Generated by cardvault-setup — safe to edit.
INSTALL_DIR="${dir}"
TRACK_BRANCH="${branch}"
INSTALL_USER="${user}"
WEB_PORT="${port}"
LAN_ACCESS="${access}"
HTTPS_ENABLED="${https}"
HTTPS_HOST="${host}"
EOF
}

load_config() {
  [[ -f $CONF_FILE ]] || return 1
  # shellcheck disable=SC1090
  . "$CONF_FILE"
  [[ -n ${INSTALL_DIR:-} && -d $INSTALL_DIR ]] || return 1
  LAN_ACCESS=${LAN_ACCESS:-yes}
  HTTPS_ENABLED=${HTTPS_ENABLED:-no}
  HTTPS_HOST=${HTTPS_HOST:-}
}

env_get() {
  local key=$1 file=$INSTALL_DIR/.env
  [[ -f $file ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n1
}

install_manager() {
  local src=$1
  [[ -f $src ]] || return 0
  if [[ $src == "$MGR" ]]; then return 0; fi
  if as_root install -m 0755 "$src" "$MGR"; then
    ok "Management console installed at ${MGR}"
  else
    warn "Could not install ${MGR}; run this script from its saved location instead."
  fi
}

find_install() {
  if load_config; then return 0; fi
  # A checkout is not an installation: only adopt directories carrying the marker
  # written by a previous successful run of this script.
  for guess in /opt/cardvault "$HOME/cardvault" "$HOME/CardVault"; do
    if [[ -f $guess/.cardvault-installed && -f $guess/package.json ]]; then
      INSTALL_DIR=$guess
      TRACK_BRANCH=$(cd "$guess" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
      [[ $TRACK_BRANCH == HEAD ]] && TRACK_BRANCH=main
      INSTALL_USER=${SUDO_USER:-$(id -un)}
      WEB_PORT=$(grep -s '^WEB_PORT=' "$guess/.env" | tail -n1 | cut -d= -f2-)
      [[ -n $WEB_PORT ]] || WEB_PORT=8080
      info "Adopting existing installation at ${INSTALL_DIR}"
      write_config "$INSTALL_DIR" "$TRACK_BRANCH" "$INSTALL_USER" "$WEB_PORT" "${LAN_ACCESS:-yes}" "${HTTPS_ENABLED:-no}" "${HTTPS_HOST:-}"
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Service units / control
# ---------------------------------------------------------------------------
NODE_BIN=''
install_units() {
  have_systemd || { warn "systemd not detected; services will be managed with nohup/PID files."; return; }
  NODE_BIN=$(command -v node)
  local group; group=$(id -gn "$INSTALL_USER" 2>/dev/null || echo "$INSTALL_USER")

  as_root tee /etc/systemd/system/cardvault-api.service >/dev/null <<EOF
[Unit]
Description=CardVault API
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=${INSTALL_USER}
Group=${group}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/apps/api/dist/index.js
Restart=always
RestartSec=5
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cardvault-api

[Install]
WantedBy=multi-user.target
EOF

  as_root tee /etc/systemd/system/cardvault-worker.service >/dev/null <<EOF
[Unit]
Description=CardVault background workers
After=network-online.target postgresql.service redis-server.service cardvault-api.service
Wants=network-online.target

[Service]
Type=simple
User=${INSTALL_USER}
Group=${group}
WorkingDirectory=${INSTALL_DIR}
Environment=AUTO_MIGRATE=false
ExecStart=${NODE_BIN} ${INSTALL_DIR}/apps/worker/dist/index.js
Restart=always
RestartSec=5
TimeoutStopSec=60
KillMode=mixed
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cardvault-worker

[Install]
WantedBy=multi-user.target
EOF
  as_root systemctl daemon-reload
  ok "systemd units written"
}

install_nginx() {
  have nginx || return 0
  detect_lan
  local tmp; tmp=$(mktemp)
  local names; names=$(server_names)
  local listen="${WEB_PORT}"
  [[ ${HTTPS_ENABLED:-no} == yes ]] && listen="127.0.0.1:${WEB_PORT}"
  cat >"$tmp" <<EOF
# Generated by cardvault-setup. Local-network only.
server {
    listen ${listen};
    server_name ${names};
    root ${INSTALL_DIR}/apps/web/dist;
    client_max_body_size 20m;
    server_tokens off;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy same-origin always;
    add_header Permissions-Policy "camera=(self), microphone=(), geolocation=()" always;

    location /api/events {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host \$http_host;
        proxy_set_header X-Forwarded-Host \$http_host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        # \$http_host keeps the port the browser used (e.g. :8080); \$host drops it,
        # which made the API reject sign-ins as cross-origin.
        proxy_set_header Host \$http_host;
        proxy_set_header X-Forwarded-Host \$http_host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }

    location / {
        add_header Cache-Control "no-cache";
        try_files \$uri /index.html;
    }
}
EOF
  if [[ ${HTTPS_ENABLED:-no} == yes && -n ${HTTPS_HOST:-} ]]; then
    # Plain-HTTP side of the HTTPS hostname (Caddy only listens on 443):
    # phones fetch the root certificate here; everything else goes to https.
    cat >>"$tmp" <<EOF

server {
    listen 80;
    server_name ${HTTPS_HOST};
    server_tokens off;

    location = /cardvault-ca.crt {
        root /etc/cardvault/ca;
        default_type application/x-x509-ca-cert;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF
  fi
  as_root install -m 0644 "$tmp" /etc/nginx/conf.d/cardvault.conf
  rm -f "$tmp"
  if as_root nginx -t >/dev/null 2>&1; then
    ok "nginx site configured on port ${WEB_PORT}"
    # apply it now (callers previously rewrote the file without reloading)
    if have_systemd && systemctl is-active --quiet nginx 2>/dev/null; then
      as_root systemctl reload nginx >/dev/null 2>&1 || true
    fi
  else
    warn "nginx configuration failed validation; inspect /etc/nginx/conf.d/cardvault.conf"
  fi
}

start_services() {
  if have_systemd && [[ -f /etc/systemd/system/cardvault-api.service ]]; then
    as_root systemctl start cardvault-api cardvault-worker || true
    have nginx && as_root systemctl enable --now nginx >/dev/null 2>&1 || true
  else
    ( cd "$INSTALL_DIR"; nohup node apps/api/dist/index.js >>"$INSTALL_DIR/api.log" 2>&1 & echo $! >"$INSTALL_DIR/api.pid" )
    ( cd "$INSTALL_DIR"; nohup node apps/worker/dist/index.js >>"$INSTALL_DIR/worker.log" 2>&1 & echo $! >"$INSTALL_DIR/worker.pid" )
  fi
}

stop_services() {
  if have_systemd && [[ -f /etc/systemd/system/cardvault-api.service ]]; then
    as_root systemctl stop cardvault-worker cardvault-api || true
  else
    for p in worker api; do
      if [[ -f $INSTALL_DIR/$p.pid ]]; then kill "$(cat "$INSTALL_DIR/$p.pid")" 2>/dev/null || true; rm -f "$INSTALL_DIR/$p.pid"; fi
    done
  fi
}

restart_services() { stop_services; sleep 1; start_services; }

services_running() {
  if have_systemd && [[ -f /etc/systemd/system/cardvault-api.service ]]; then
    local unit
    for unit in cardvault-api cardvault-worker; do
      systemctl is-active --quiet "$unit" 2>/dev/null && return 0
    done
  else
    local p
    for p in api worker; do
      if [[ -f $INSTALL_DIR/$p.pid ]]; then
        kill -0 "$(cat "$INSTALL_DIR/$p.pid" 2>/dev/null)" 2>/dev/null && return 0
      fi
    done
  fi
  return 1
}

enable_boot() {
  have_systemd || { warn "Boot start requires systemd; skipping."; return; }
  as_root systemctl enable cardvault-api cardvault-worker nginx postgresql redis-server cardvault-lan.service >/dev/null 2>&1 || true
  [[ ${HTTPS_ENABLED:-no} == yes ]] && as_root systemctl enable caddy >/dev/null 2>&1 || true
  ok "Services enabled at boot"
}

lan_rich_rule() {
  printf 'rule family="ipv4" source address="%s" port port="%s" protocol="tcp" accept' "$1" "$2"
}

lan_ports() {
  local ports="$WEB_PORT"
  [[ ${HTTPS_ENABLED:-no} == yes ]] && ports="$ports 443 80"
  printf '%s' "$ports"
}

firewall_active() {
  if have ufw && as_root ufw status 2>/dev/null | grep -q '^Status: active'; then
    printf 'ufw'
  elif have firewall-cmd && systemctl is-active --quiet firewalld 2>/dev/null; then
    printf 'firewalld'
  fi
}

configure_firewall() {
  [[ ${LAN_ACCESS:-yes} == yes ]] || return 0
  local net port rule fw ports
  ports=$(lan_ports)
  fw=$(firewall_active)
  if [[ $fw == ufw ]]; then
    for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
      for port in $ports; do
        as_root ufw allow from "$net" to any port "$port" proto tcp comment 'CardVault LAN' >/dev/null 2>&1 || true
      done
    done
    ok "ufw: LAN access allowed on ports ${ports}"
  elif [[ $fw == firewalld ]]; then
    for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
      for port in $ports; do
        rule=$(lan_rich_rule "$net" "$port")
        as_root firewall-cmd --permanent --add-rich-rule="$rule" >/dev/null 2>&1 || true
      done
    done
    as_root firewall-cmd --reload >/dev/null 2>&1 || true
    ok "firewalld: LAN access allowed on ports ${ports}"
  else
    info "No active host firewall detected; ports ${ports} are open locally."
  fi
}

remove_firewall_rules() {
  local net port rule fw ports
  ports=$(lan_ports)
  fw=$(firewall_active)
  if [[ $fw == ufw ]]; then
    for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
      for port in $ports; do
        as_root ufw delete allow from "$net" to any port "$port" proto tcp >/dev/null 2>&1 || true
      done
    done
  elif [[ $fw == firewalld ]]; then
    for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
      for port in $ports; do
        rule=$(lan_rich_rule "$net" "$port")
        as_root firewall-cmd --permanent --remove-rich-rule="$rule" >/dev/null 2>&1 || true
      done
    done
    as_root firewall-cmd --reload >/dev/null 2>&1 || true
  fi
}

install_lan_unit() {
  have_systemd || return 0
  if [[ ! -x $MGR ]]; then
    warn "Management console not installed; skipping the boot LAN refresh unit."
    return 0
  fi
  as_root tee /etc/systemd/system/cardvault-lan.service >/dev/null <<EOF
[Unit]
Description=Refresh CardVault LAN hostname, IPs and firewall rules
After=network-online.target
Before=nginx.service cardvault-api.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${MGR} --refresh-lan

[Install]
WantedBy=multi-user.target
EOF
  as_root systemctl daemon-reload
  if [[ ${LAN_ACCESS:-yes} == yes ]]; then
    as_root systemctl enable cardvault-lan.service >/dev/null 2>&1 || true
  else
    as_root systemctl disable cardvault-lan.service >/dev/null 2>&1 || true
  fi
}

ensure_web_origin() {
  detect_lan
  local current; current=$(env_get WEB_ORIGIN)
  if [[ -z $current || $current == http://localhost:* || $current == http://127.0.0.1:* ]]; then
    local value="http://${LAN_HOSTNAME}:${WEB_PORT}"
    sed -i "s|^WEB_ORIGIN=.*|WEB_ORIGIN=${value}|" "$INSTALL_DIR/.env"
    ok "WEB_ORIGIN set to ${value}"
  fi
}

refresh_lan() {
  detect_lan
  task "Refreshing LAN names and firewall rules"
  ensure_web_origin
  install_nginx
  # keep the Caddyfile current too (restarts Caddy only if it changed or was down)
  if [[ ${HTTPS_ENABLED:-no} == yes ]] && have caddy; then install_https; fi
  configure_firewall
  if have_systemd && systemctl is-active --quiet nginx 2>/dev/null; then
    as_root systemctl reload nginx >/dev/null 2>&1 || as_root systemctl restart nginx >/dev/null 2>&1 || true
  fi
  ok "Listening on http://${LAN_HOSTNAME}:${WEB_PORT}"
  [[ -n $PRIMARY_LAN_IP ]] && ok "Also available at http://${PRIMARY_LAN_IP}:${WEB_PORT}"
}

service_status() {
  printf '  %-28s %s\n' 'SERVICE' 'STATUS'
  for s in cardvault-api cardvault-worker nginx caddy postgresql redis-server; do
    local state='n/a'
    if have_systemd; then state=$(systemctl is-active "$s" 2>/dev/null || true); fi
    if [[ $state == active ]]; then printf '  %-28s %s%s%s\n' "$s" "$GREEN" "$state" "$RESET"
    else printf '  %-28s %s%s%s\n' "$s" "$YELLOW" "${state:-not installed}" "$RESET"; fi
  done
  detect_lan
  printf '\n  %sURLs:%s\n' "$DIM" "$RESET"
  if [[ ${HTTPS_ENABLED:-no} == yes ]]; then
    printf '  • https://%s\n' "${HTTPS_HOST:-cardvault.home}"
    printf '  • http://127.0.0.1:%s (local proxy only)\n' "$WEB_PORT"
  else
    printf '  • http://localhost:%s\n' "$WEB_PORT"
    printf '  • http://%s:%s\n' "$LAN_HOSTNAME" "$WEB_PORT"
    [[ -n $PRIMARY_LAN_IP ]] && printf '  • http://%s:%s\n' "$PRIMARY_LAN_IP" "$WEB_PORT"
  fi
}

# ---------------------------------------------------------------------------
# Fresh install
# ---------------------------------------------------------------------------
fresh_install() {
  banner
  section "New installation"
  : >"$RUN_LOG" 2>/dev/null || true
  info "Detailed progress is logged to ${RUN_LOG}"
  info "Answer a few questions, then the installer will take it from here."

  INSTALL_DIR=${CARDVAULT_DIR:-$(prompt_value "Install directory" /opt/cardvault)}
  TRACK_BRANCH=$(prompt_value "Git branch to track" "$BRANCH_DEFAULT")
  WEB_PORT=${CARDVAULT_PORT:-$(prompt_value "Web port" 8080)}
  INSTALL_USER=${CARDVAULT_USER:-${SUDO_USER:-$(id -un)}}
  [[ $INSTALL_USER == root && -n ${SUDO_USER:-} ]] && INSTALL_USER=$SUDO_USER

  ADMIN_USERNAME=$(prompt_value "Admin username" admin)
  local pw=''
  while [[ ${#pw} -lt 8 ]]; do
    pw=$(prompt_secret "Admin password (min 8 characters)")
    [[ ${#pw} -ge 8 ]] || warn "Password must be at least 8 characters."
  done
  ADMIN_PASSWORD=$pw
  DB_PASS=$(openssl rand -hex 24)
  SESSION_SECRET=$(openssl rand -base64 48)

  local boot=no
  ask "Start CardVault automatically on boot?" n && boot=yes
  LAN_ACCESS=yes
  ask "Allow other devices on your LAN to use CardVault?" y || LAN_ACCESS=no
  HTTPS_ENABLED=no
  HTTPS_HOST=''
  if ask "Set up HTTPS with a local certificate (needed for the live phone camera)?" y; then
    HTTPS_ENABLED=yes
    HTTPS_HOST=$(prompt_value "Hostname for HTTPS (must resolve on your LAN)" "${LAN_FQDN:-cardvault.home}")
  fi

  tui_action 'Installing CardVault' fresh_install_runs
  tui_report 'Installation complete' install_summary
}

# The installation itself. On the TUI this runs on the progress screen with
# raw output captured to the run log; ok/warn/… feed the on-screen checklist.
fresh_install_runs() {
  STEP_TOTAL=8
  step "Preparing system"
  task "Detecting the operating system"
  detect_os
  ok "Detected ${OS_PRETTY}"
  task "Checking administrator privileges"
  ensure_sudo
  task "Creating ${INSTALL_DIR}"
  as_root mkdir -p "$INSTALL_DIR"
  as_root chown -R "$INSTALL_USER" "$INSTALL_DIR"

  step "Installing required software"
  install_packages

  step "Configuring PostgreSQL and Redis"
  configure_postgres
  configure_redis

  step "Downloading CardVault source"
  task "Cloning ${REPO} (${TRACK_BRANCH})"
  if have git && EXPECTED_SECONDS=90 run "Clone repository" git clone --branch "$TRACK_BRANCH" "$REPO" "$INSTALL_DIR.tmp"; then
    if [[ $SCRIPT_DIR == "$INSTALL_DIR" ]]; then
      # Never delete the directory the running script lives in.
      (cd "$INSTALL_DIR.tmp" && tar -cf - .) | as_root tar -xf - -C "$INSTALL_DIR"
      as_root rm -rf "$INSTALL_DIR.tmp"
    else
      as_root rm -rf "$INSTALL_DIR"
      mv "$INSTALL_DIR.tmp" "$INSTALL_DIR"
    fi
    ok "Cloned ${REPO} (${TRACK_BRANCH})"
  elif [[ -n $SCRIPT_DIR && -f $SCRIPT_DIR/pnpm-workspace.yaml ]]; then
    warn "Clone failed; copying the local checkout instead."
    as_root mkdir -p "$INSTALL_DIR"
    (cd "$SCRIPT_DIR" && tar --exclude=./node_modules --exclude=./.env --exclude=./storage/* --exclude=./backups -cf - .) | as_root tar -xf - -C "$INSTALL_DIR"
    ok "Copied local checkout"
  else
    die "Could not download ${REPO}. Check network access and the branch name."
  fi
  as_root chown -R "$INSTALL_USER" "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR/storage" "$INSTALL_DIR/backups"

  step "Writing configuration"
  task "Detecting this PC's hostname and LAN IP addresses"
  detect_lan
  ok "Host: ${LAN_HOSTNAME}${PRIMARY_LAN_IP:+  •  LAN IP: ${PRIMARY_LAN_IP}}"
  task "Generating session secret and database password"
  if [[ ${HTTPS_ENABLED:-no} == yes && -n ${HTTPS_HOST:-} ]]; then
    WEB_ORIGIN_VALUE="https://${HTTPS_HOST}"
    COOKIE_VALUE=true
  else
    WEB_ORIGIN_VALUE="http://${LAN_HOSTNAME}:${WEB_PORT}"
    COOKIE_VALUE=false
  fi
  task "Writing ${INSTALL_DIR}/.env"
  cat >"$INSTALL_DIR/.env.tmp" <<EOF
NODE_ENV=production
DATABASE_URL=postgres://cardvault:${DB_PASS}@127.0.0.1:5432/cardvault
REDIS_URL=redis://127.0.0.1:6379
SESSION_SECRET=${SESSION_SECRET}
STORAGE_DIR=${INSTALL_DIR}/storage
API_PORT=3000
API_HOST=127.0.0.1
COOKIE_SECURE=${COOKIE_VALUE}
WEB_ORIGIN=${WEB_ORIGIN_VALUE}
WEB_PORT=${WEB_PORT}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
POSTGRES_PASSWORD=${DB_PASS}
SEED_DEMO=false
RESEARCH_REFRESH_HOURS=24
WORKER_CONCURRENCY=2
EOF
  mv "$INSTALL_DIR/.env.tmp" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  as_root chown "$INSTALL_USER" "$INSTALL_DIR/.env"
  printf 'installed=%s\nbranch=%s\nport=%s\n' "$(date -Iseconds)" "$TRACK_BRANCH" "$WEB_PORT" > "$INSTALL_DIR/.cardvault-installed"
  write_config "$INSTALL_DIR" "$TRACK_BRANCH" "$INSTALL_USER" "$WEB_PORT" "${LAN_ACCESS:-yes}" "${HTTPS_ENABLED:-no}" "${HTTPS_HOST:-}"
  ok "Configuration saved to ${INSTALL_DIR}/.env"

  step "Installing application and building"
  task "Downloading workspace dependencies with pnpm"
  EXPECTED_SECONDS=240 run "pnpm install" bash -c "cd '$INSTALL_DIR' && pnpm install --frozen-lockfile"
  task "Compiling packages and applications"
  EXPECTED_SECONDS=120 run "pnpm build" bash -c "cd '$INSTALL_DIR' && pnpm build"

  step "Initialising database and admin user"
  task "Applying the database schema"
  EXPECTED_SECONDS=60 run "Apply migrations" bash -c "cd '$INSTALL_DIR' && pnpm db:migrate"
  task "Loading the card catalog"
  EXPECTED_SECONDS=60 run "Seed catalog" bash -c "cd '$INSTALL_DIR' && pnpm db:seed"
  task "Creating the administrator account"
  EXPECTED_SECONDS=45 run "Create administrator" bash -c "cd '$INSTALL_DIR' && pnpm user:create --bootstrap"
  ok "Administrator '${ADMIN_USERNAME}' created"

  step "Installing services and web server"
  task "Writing systemd units"
  install_units
  task "Configuring nginx on port ${WEB_PORT} for ${LAN_HOSTNAME} and LAN IPs"
  install_nginx
  if [[ ${HTTPS_ENABLED:-no} == yes ]]; then
    task "Configuring Caddy for https://${HTTPS_HOST}"
    install_https
  fi
  if [[ -n $SCRIPT_PATH ]]; then
    install_manager "$SCRIPT_PATH"
  else
    warn "Started via a pipe, so no manager copy was installed. Save this script and run it again to get '${MGR}'."
  fi
  task "Installing the boot-time LAN refresh"
  install_lan_unit

  step "Starting CardVault"
  if [[ $boot == yes ]]; then task "Enabling services at boot"; enable_boot; fi
  task "Checking the local firewall"
  configure_firewall
  task "Starting API, worker and web server"
  restart_services
  info "Waiting for services to become ready…"
  EXPECTED_SECONDS=10 run "Health check" sleep 3
}

install_summary() {
  section "Installation complete"
  ok "CardVault is running at http://localhost:${WEB_PORT}"
  info "On other devices: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${WEB_PORT}"
  info "Management console: ${MGR}"
  if [[ ${HTTPS_ENABLED:-no} == yes ]]; then
    info "Live phone camera: https://${HTTPS_HOST}"
  else
    info "Phone camera: use HTTPS or 'Upload photo instead' on plain HTTP."
  fi
  service_status
}

# ---------------------------------------------------------------------------
# Upgrade
# ---------------------------------------------------------------------------
check_for_updates() {
  section "Update check"
  local branch=${TRACK_BRANCH:-main} count='' log=''
  if ! have git; then warn "git is missing; cannot check for updates."; return; fi
  if ! (cd "$INSTALL_DIR" && git fetch --quiet origin "$branch" 2>/dev/null); then
    warn "Could not reach origin; update check skipped."
    return
  fi
  # Installs cloned with --depth 1 don't know their own history, which makes
  # every commit ever merged look "new". Fetch the full history once.
  if [[ $(cd "$INSTALL_DIR" && git rev-parse --is-shallow-repository 2>/dev/null) == true ]]; then
    (cd "$INSTALL_DIR" && git fetch --quiet --unshallow origin 2>/dev/null) || true
  fi
  count=$(cd "$INSTALL_DIR" && git rev-list --count "HEAD..origin/${branch}" 2>/dev/null || echo 0)
  if [[ $count == 0 ]]; then ok "Already up to date."; return; fi

  local changes width shown
  changes=$(cd "$INSTALL_DIR" && git rev-list --no-merges --count "HEAD..origin/${branch}" 2>/dev/null || echo "$count")
  (( changes > 0 )) || changes=$count
  warn "${changes} new change(s) available:"
  width=$(( ${TERM_COLS:-0} > 0 ? TERM_COLS : $(tput cols 2>/dev/null || echo 100) ))
  (( width > 20 )) || width=80
  shown=0
  while IFS= read -r log; do
    printf '    %s\n' "${log:0:$(( width - 6 ))}"
    shown=$(( shown + 1 ))
  done < <(cd "$INSTALL_DIR" && git --no-pager log --no-merges --format='%h %s' "HEAD..origin/${branch}" 2>/dev/null | head -12)
  (( changes > shown )) && info "…and $(( changes - shown )) more"

  if ask "Upgrade to the latest version now?" n; then
    do_upgrade "$branch"
  else
    warn "Upgrade declined. Opening the management menu."
  fi
}

do_upgrade() {
  local branch=$1
  section "Upgrading CardVault"
  # Only edits to tracked files count; runtime files (pids, logs) are not source changes.
  if [[ -n $(cd "$INSTALL_DIR" && git status --porcelain --untracked-files=no 2>/dev/null) ]]; then
    warn "Local source files have been modified:"
    (cd "$INSTALL_DIR" && git status --short --untracked-files=no | head -8 | sed 's/^/    /') || true
    ask "Discard local source changes and upgrade?" n || { warn "Upgrade cancelled."; return; }
    (cd "$INSTALL_DIR" && git reset --hard "origin/${branch}")
  fi
  run "Fetch and apply updates" bash -c "cd '$INSTALL_DIR' && git pull --ff-only origin '$branch'"
  EXPECTED_SECONDS=60 run "Update dependencies" bash -c "cd '$INSTALL_DIR' && pnpm install --frozen-lockfile"
  EXPECTED_SECONDS=150 run "Rebuild application" bash -c "cd '$INSTALL_DIR' && pnpm build"
  EXPECTED_SECONDS=20 run "Apply migrations" bash -c "cd '$INSTALL_DIR' && pnpm db:migrate && pnpm db:seed"
  write_config "$INSTALL_DIR" "$branch" "$INSTALL_USER" "$WEB_PORT" "${LAN_ACCESS:-yes}" "${HTTPS_ENABLED:-no}" "${HTTPS_HOST:-}"
  if [[ -f $INSTALL_DIR/scripts/install.sh ]]; then
    install_manager "$INSTALL_DIR/scripts/install.sh"
    # This function belongs to the console that *started* the upgrade. Let the
    # freshly pulled script regenerate nginx etc., so fixes to its templates
    # take effect now rather than on the next upgrade.
    ensure_sudo # refresh cached credentials in the foreground; the child must never prompt
    if ! EXPECTED_SECONDS=15 run "Refresh nginx and network settings" bash "$INSTALL_DIR/scripts/install.sh" --refresh-lan; then
      warn "Falling back to the current console's nginx settings."
      install_nginx
    fi
  else
    install_nginx
  fi
  restart_services
  sleep 2
  ok "Upgrade complete."
}

# ---------------------------------------------------------------------------
# Menu actions
# ---------------------------------------------------------------------------
backup_dir() {
  local d="$INSTALL_DIR/backups/$1"
  mkdir -p "$d"
  printf '%s' "$d"
}

db_export() {
  section "Export database"
  local dir; dir=$(backup_dir db)
  local file="$dir/cardvault-$(date +%Y%m%d-%H%M%S).dump"
  if have pg_dump && pg_dump --format=custom --compress=9 --no-owner --file "$file" "$(env_get DATABASE_URL)"; then
    ok "Database exported: ${file}"
  else
    err "Database export failed."
  fi
  pause
}

db_import() {
  section "Import database"
  local -a files=()
  while IFS= read -r f; do files+=("$f"); done < <(find "$INSTALL_DIR/backups/db" -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -rn | cut -d' ' -f2-)
  (( ${#files[@]} )) || { warn "No exports found in ${INSTALL_DIR}/backups/db"; pause; return; }
  local n; n=$(pick_from 'Import database' "Choose a backup number" "${files[@]##*/}")
  [[ $n =~ ^[0-9]+$ ]] && (( n >= 1 && n <= ${#files[@]} )) || { warn "Invalid selection."; pause; return; }
  local file=${files[$((n-1))]}
  warn "This REPLACES the current database. Existing sessions will be lost."
  ask "Continue with $(basename "$file")?" n || { pause; return; }
  stop_services
  local url; url=$(env_get DATABASE_URL)
  if pg_restore --clean --if-exists --no-owner --dbname "$url" "$file"; then
    ok "Database restored from ${file}"
  else
    err "Restore failed; starting services anyway."
  fi
  start_services
  pause
}

db_clear() {
  section "Clear database"
  warn "This deletes ALL collections, scans, users and price history."
  warn "Export a backup first if you might want it later."
  ask "Do you want to continue?" n || { pause; return; }
  confirm_type CLEAR || { warn "Cancelled."; pause; return; }
  stop_services
  pg_admin dropdb --if-exists --force cardvault
  pg_admin createdb -O cardvault cardvault
  (cd "$INSTALL_DIR" && pnpm db:migrate && pnpm db:seed && pnpm user:create --bootstrap)
  local images=no
  ask "Also delete stored card images?" n && images=yes
  if [[ $images == yes ]]; then
    as_root rm -rf "$INSTALL_DIR/storage/scans" "$INSTALL_DIR/storage/thumbnails" "$INSTALL_DIR/storage/cards" "$INSTALL_DIR/storage/users"
    ok "Stored images removed."
  fi
  start_services
  ok "Database reset to a fresh state."
  pause
}

list_users() {
  psql "$(env_get DATABASE_URL)" -tAc 'SELECT username FROM users ORDER BY username' 2>/dev/null | sed '/^[[:space:]]*$/d'
}

change_password() {
  section "Change user password"
  local -a users=()
  mapfile -t users < <(list_users)
  (( ${#users[@]} )) || { warn "No users found."; pause; return; }
  local n; n=$(pick_from 'Change user password' "Choose a user number" "${users[@]}")
  [[ $n =~ ^[0-9]+$ ]] && (( n >= 1 && n <= ${#users[@]} )) || { warn "Invalid selection."; pause; return; }
  local user=${users[$((n-1))]}
  local pw pw2
  while true; do
    pw=$(prompt_secret "New password for ${user}")
    [[ ${#pw} -ge 8 ]] || { warn "At least 8 characters required."; continue; }
    pw2=$(prompt_secret "Confirm password")
    [[ $pw == "$pw2" ]] && break
    warn "Passwords do not match."
  done
  if CARDVAULT_ROOT="$INSTALL_DIR" CARDVAULT_TARGET_USER="$user" CARDVAULT_NEW_PASSWORD="$pw" DATABASE_URL="$(env_get DATABASE_URL)" node --input-type=module <<'NODE'
const root = process.env.CARDVAULT_ROOT;
const { hashPassword } = await import(root + '/apps/api/dist/auth/password.js');
const { createDb, users, sessions, eq } = await import(root + '/packages/database/dist/index.js');
const name = process.env.CARDVAULT_TARGET_USER.toLowerCase();
const { db, sql } = createDb(process.env.DATABASE_URL, { max: 1 });
try {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.username, name)).limit(1);
  if (!rows.length) throw new Error('User not found');
  await db.update(users).set({ passwordHash: await hashPassword(process.env.CARDVAULT_NEW_PASSWORD), failedLogins: 0, lockedUntil: null }).where(eq(users.id, rows[0].id));
  await db.delete(sessions).where(eq(sessions.userId, rows[0].id));
  console.log('Password updated; existing sessions signed out.');
} finally {
  await sql.end();
}
NODE
  then ok "Password changed for ${user}."; else err "Password change failed."; fi
  pause
}

create_user() {
  section "Create user"
  local username display admin='' pw pw2
  username=$(prompt_value "Username" '')
  [[ -n $username ]] || { warn "Username required."; pause; return; }
  display=$(prompt_value "Display name" "$username")
  while true; do
    pw=$(prompt_secret "Password")
    [[ ${#pw} -ge 8 ]] || { warn "At least 8 characters required."; continue; }
    pw2=$(prompt_secret "Confirm password")
    [[ $pw == "$pw2" ]] && break
    warn "Passwords do not match."
  done
  local -a extra=()
  ask "Give this user administrator rights?" n && extra+=(--admin)
  if printf '%s\n' "$pw" | (cd "$INSTALL_DIR" && pnpm --filter @cardvault/api user:create "$username" "$display" "${extra[@]}"); then
    ok "User ${username} created."
  else
    err "Could not create user."
  fi
  pause
}

images_export() {
  section "Export card images"
  local dir; dir=$(backup_dir images)
  local file="$dir/storage-$(date +%Y%m%d-%H%M%S).tar.gz"
  if tar -C "$INSTALL_DIR/storage" -czf "$file" .; then ok "Images exported: ${file}"; else err "Image export failed."; fi
  pause
}

images_import() {
  section "Import card images"
  local -a files=()
  while IFS= read -r f; do files+=("$f"); done < <(find "$INSTALL_DIR/backups/images" -maxdepth 1 -type f -name '*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | cut -d' ' -f2-)
  (( ${#files[@]} )) || { warn "No image archives found."; pause; return; }
  local n; n=$(pick_from 'Import card images' "Choose an archive number" "${files[@]##*/}")
  [[ $n =~ ^[0-9]+$ ]] && (( n >= 1 && n <= ${#files[@]} )) || { warn "Invalid selection."; pause; return; }
  warn "This overwrites current images with the selected archive."
  ask "Continue?" n || { pause; return; }
  stop_services
  tar -C "$INSTALL_DIR/storage" -xzf "${files[$((n-1))]}"
  start_services
  ok "Images restored."
  pause
}

edit_config() {
  section "Edit configuration"
  local editor=${CARDVAULT_EDITOR:-${EDITOR:-nano}}
  have "$editor" || editor=nano
  "$editor" "$INSTALL_DIR/.env" || true
  warn "Restart services for changes to take effect."
  ask "Restart now?" y && restart_services
  pause
}

view_logs() {
  section "Live logs"
  local unit=cardvault-api
  [[ $(pick_from 'Live logs' "Which service" 'API' 'Worker') == 2 ]] && unit=cardvault-worker
  if have_systemd; then
    info "Showing ${unit} (Ctrl-C to return)"
    as_root journalctl -u "$unit" -f -n 50 || true
  else
    local f="$INSTALL_DIR/${unit#cardvault-}.log"
    info "Showing ${f} (Ctrl-C to return)"
    tail -f -n 50 "$f" 2>/dev/null || true
  fi
}

show_info() {
  section "Installation details"
  printf '  %-22s %s\n' 'Install directory' "$INSTALL_DIR"
  printf '  %-22s %s\n' 'Tracked branch' "$TRACK_BRANCH"
  printf '  %-22s %s\n' 'Run as user' "$INSTALL_USER"
  printf '  %-22s %s\n' 'Web URL' "http://localhost:${WEB_PORT}"
  printf '  %-22s %s\n' 'Management console' "$MGR"
  printf '  %-22s %s\n' 'Backups' "$INSTALL_DIR/backups"
  (cd "$INSTALL_DIR" && printf '  %-22s %s\n' 'Installed commit' "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)")
  service_status
  pause
}

lan_enable() {
  LAN_ACCESS=yes
  write_config "$INSTALL_DIR" "$TRACK_BRANCH" "$INSTALL_USER" "$WEB_PORT" "$LAN_ACCESS" "${HTTPS_ENABLED:-no}" "${HTTPS_HOST:-}"
  install_lan_unit
  configure_firewall
  refresh_lan
  restart_services
  ok "LAN access enabled."
}

lan_disable() {
  LAN_ACCESS=no
  write_config "$INSTALL_DIR" "$TRACK_BRANCH" "$INSTALL_USER" "$WEB_PORT" "$LAN_ACCESS" "${HTTPS_ENABLED:-no}" "${HTTPS_HOST:-}"
  install_lan_unit
  remove_firewall_rules
  ok "LAN boot refresh disabled and firewall rules removed. nginx still serves on port ${WEB_PORT}."
}

lan_origin_host() {
  if [[ ${HTTPS_ENABLED:-no} == yes && -n ${HTTPS_HOST:-} ]]; then
    set_https_env yes "$HTTPS_HOST"
  else
    sed -i "s|^WEB_ORIGIN=.*|WEB_ORIGIN=http://${LAN_HOSTNAME}:${WEB_PORT}|" "$INSTALL_DIR/.env"
    ok "WEB_ORIGIN is now http://${LAN_HOSTNAME}:${WEB_PORT}"
  fi
  restart_services
}

lan_origin_ip() {
  if [[ ${HTTPS_ENABLED:-no} == yes ]]; then
    warn "HTTPS uses the configured hostname. Use menu 18 to change it."
    return
  fi
  [[ -n $PRIMARY_LAN_IP ]] || { warn "No LAN IP detected."; return; }
  sed -i "s|^WEB_ORIGIN=.*|WEB_ORIGIN=http://${PRIMARY_LAN_IP}:${WEB_PORT}|" "$INSTALL_DIR/.env"
  restart_services
  ok "WEB_ORIGIN is now http://${PRIMARY_LAN_IP}:${WEB_PORT}"
}

lan_menu() {
  while true; do
    detect_lan
    local -a items=(
      "=Hostname: ${LAN_HOSTNAME}|"
      "=FQDN: ${LAN_FQDN}|"
    )
    local i ninfo=2
    if (( ${#LAN_IPS[@]} )); then
      for i in "${LAN_IPS[@]}"; do items+=("=LAN IP: ${i}|"); ninfo=$(( ninfo + 1 )); done
    else
      items+=("=No private LAN IP detected.|"); ninfo=$(( ninfo + 1 ))
    fi
    items+=(
      "=http://${LAN_HOSTNAME}:${WEB_PORT} from other devices|"
      "Refresh addresses, firewall and nginx now|"
      "Enable LAN access|firewall rules + boot refresh"
      "Disable LAN access|remove firewall and boot rules"
      "Set WEB_ORIGIN to the hostname|http://${LAN_HOSTNAME}:${WEB_PORT}"
      "Set WEB_ORIGIN to the LAN IP|http://${PRIMARY_LAN_IP:-<none>}:${WEB_PORT}"
      "Back|to the management console"
    )
    ninfo=$(( ninfo + 1 ))
    local sel
    if (( TERMINAL_UI )) && [[ ${CARDVAULT_VERBOSE:-0} != 1 ]]; then
      # selectable actions follow the info rows
      sel=$(tui_menu 'LAN access' "$ninfo" "${items[@]}") || return 0
      sel=$(( sel - ninfo + 1 ))   # info rows → action 1..6
    else
      clear_content
      section "LAN access"
      printf '  %-14s %s\n' 'Hostname:' "$LAN_HOSTNAME"
      printf '  %-14s %s\n' 'FQDN:' "$LAN_FQDN"
      if (( ${#LAN_IPS[@]} )); then
        for i in "${LAN_IPS[@]}"; do printf '  %-14s %s\n' 'LAN IP:' "$i"; done
      else
        warn "No private LAN IP detected."
      fi
      printf '\n  %sAddresses to use from other devices:%s\n' "$BOLD" "$RESET"
      printf '  • http://%s:%s\n' "$LAN_HOSTNAME" "$WEB_PORT"
      [[ -n $PRIMARY_LAN_IP ]] && printf '  • http://%s:%s\n' "$PRIMARY_LAN_IP" "$WEB_PORT"
      printf '\n'
      printf '  %s 1)%s Refresh addresses, firewall and nginx now\n' "$CYAN" "$RESET"
      printf '  %s 2)%s Enable LAN access (firewall + boot refresh)\n' "$CYAN" "$RESET"
      printf '  %s 3)%s Disable LAN firewall rules / boot refresh\n' "$CYAN" "$RESET"
      printf '  %s 4)%s Set WEB_ORIGIN to the hostname\n' "$CYAN" "$RESET"
      printf '  %s 5)%s Set WEB_ORIGIN to the LAN IP\n' "$CYAN" "$RESET"
      printf '  %s 0)%s Back\n\n' "$CYAN" "$RESET"
      sel=$(prompt_value "Select an option" 0)
    fi
    case $sel in
      1) tui_action 'Refreshing LAN settings' refresh_lan restart_services ;;
      2) tui_action 'Enabling LAN access' lan_enable ;;
      3) tui_action 'Disabling LAN access' lan_disable ;;
      4) tui_action 'Setting WEB_ORIGIN to the hostname' lan_origin_host ;;
      5) tui_action 'Setting WEB_ORIGIN to the LAN IP' lan_origin_ip ;;
      0|6) return 0 ;;
      *) warn "Unknown option: ${sel}" ;;
    esac
  done
}

lan_diagnose() {
  section "Network diagnostics"
  detect_lan
  printf '  %-14s %s\n' 'Hostname:' "$LAN_HOSTNAME"
  printf '  %-14s %s\n' 'FQDN:' "$LAN_FQDN"
  printf '  %-14s %s\n' 'LAN IPs:' "${LAN_IPS[*]:-none detected}"
  printf '  %-14s %s\n' 'Web port:' "$WEB_PORT"

  printf '\n  %sListening sockets:%s\n' "$BOLD" "$RESET"
  if have ss; then
    if ss -tlnp 2>/dev/null | grep -E "[:.]${WEB_PORT}([[:space:]]|$)"; then :; else warn "Nothing is listening on port ${WEB_PORT}."; fi
  elif have netstat; then
    if netstat -tlnp 2>/dev/null | grep -E "[:.]${WEB_PORT}([[:space:]]|$)"; then :; else warn "Nothing is listening on port ${WEB_PORT}."; fi
  else
    info "Install iproute2/net-tools to inspect listening sockets."
  fi

  printf '\n  %sServices:%s\n' "$BOLD" "$RESET"
  local s state
  for s in nginx cardvault-api cardvault-worker; do
    state='unknown'
    if have_systemd; then state=$(systemctl is-active "$s" 2>/dev/null || true); fi
    if [[ $state == active ]]; then printf '  %-20s %s%s%s\n' "$s" "$GREEN" "$state" "$RESET"
    else printf '  %-20s %s%s%s\n' "$s" "$YELLOW" "${state:-inactive}" "$RESET"; fi
  done

  printf '\n  %sFirewall:%s\n' "$BOLD" "$RESET"
  local fw; fw=$(firewall_active)
  if [[ -z $fw ]]; then
    info "No active host firewall detected."
  else
    printf '  %-20s %s\n' 'Active firewall:' "$fw"
    if [[ $fw == ufw ]]; then
      if as_root ufw status 2>/dev/null | grep -q "$WEB_PORT"; then
        ok "ufw has a rule mentioning port ${WEB_PORT}"
      else
        warn "ufw has no rule for port ${WEB_PORT}. Use menu 16 → 2."
      fi
    else
      if as_root firewall-cmd --list-rich-rules 2>/dev/null | grep -q "$WEB_PORT"; then
        ok "firewalld has a rule for port ${WEB_PORT}"
      else
        warn "firewalld has no rule for port ${WEB_PORT}. Use menu 16 → 2."
      fi
    fi
  fi

  printf '\n  %sTry from another device:%s\n' "$BOLD" "$RESET"
  [[ -z $PRIMARY_LAN_IP ]] || printf '  • http://%s:%s\n' "$PRIMARY_LAN_IP" "$WEB_PORT"
  printf '  • http://%s:%s\n' "$LAN_HOSTNAME" "$WEB_PORT"
  info "If nothing is listening, start services from menu option 2."
  pause
}

https_enable() {
  install_caddy
  HTTPS_ENABLED=yes
  HTTPS_HOST=$(prompt_value "Hostname for HTTPS (must resolve on your LAN)" "${HTTPS_HOST:-cardvault.home}")
  set_https_env yes "$HTTPS_HOST"
  install_nginx
  install_https
  configure_firewall
  write_config "$INSTALL_DIR" "$TRACK_BRANCH" "$INSTALL_USER" "$WEB_PORT" "$LAN_ACCESS" "$HTTPS_ENABLED" "$HTTPS_HOST"
  restart_services
  ok "HTTPS enabled at https://${HTTPS_HOST}."
}

https_disable() {
  HTTPS_ENABLED=yes remove_firewall_rules
  HTTPS_ENABLED=no
  set_https_env no
  install_nginx
  write_config "$INSTALL_DIR" "$TRACK_BRANCH" "$INSTALL_USER" "$WEB_PORT" "$LAN_ACCESS" "$HTTPS_ENABLED" "${HTTPS_HOST:-}"
  if have_systemd; then as_root systemctl disable --now caddy >/dev/null 2>&1 || true; fi
  restart_services
  ok "HTTPS disabled. Plain HTTP is back on port ${WEB_PORT}."
}

https_menu() {
  while true; do
    local -a items
    if [[ ${HTTPS_ENABLED:-no} == yes ]]; then
      items+=("=Enabled at https://${HTTPS_HOST:-cardvault.home}|")
    else
      items+=("=HTTPS is currently disabled.|")
    fi
    items+=(
      "Enable HTTPS|Caddy + local CA"
      "Disable HTTPS|back to plain HTTP"
      "Certificate install instructions|what to do on phones and tablets"
      "Back|to the management console"
    )
    local sel
    if (( TERMINAL_UI )) && [[ ${CARDVAULT_VERBOSE:-0} != 1 ]]; then
      # 1 info row, then actions at raw indexes 1..4 = action numbers 1..4
      sel=$(tui_menu 'HTTPS (local CA)' 1 "${items[@]}") || return 0
    else
      clear_content
      section "HTTPS (local CA)"
      if [[ ${HTTPS_ENABLED:-no} == yes ]]; then
        ok "Enabled at https://${HTTPS_HOST:-cardvault.home}"
      else
        info "HTTPS is currently disabled."
      fi
      printf '\n'
      printf '  %s 1)%s Enable HTTPS (Caddy + local CA)\n' "$CYAN" "$RESET"
      printf '  %s 2)%s Disable HTTPS (back to plain HTTP)\n' "$CYAN" "$RESET"
      printf '  %s 3)%s Show certificate install instructions\n' "$CYAN" "$RESET"
      printf '  %s 0)%s Back\n\n' "$CYAN" "$RESET"
      sel=$(prompt_value "Select an option" 0)
    fi
    case $sel in
      1) tui_action 'Enabling HTTPS' https_enable; tui_report 'Certificate install' https_instructions ;;
      2) tui_action 'Disabling HTTPS' https_disable ;;
      3) tui_report 'Certificate install' https_instructions ;;
      0|4) return 0 ;;
      *) warn "Unknown option: ${sel}" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Wipe & reinstall
# ---------------------------------------------------------------------------
WIPE_BACKUP_ROOT=/var/backups/cardvault

# Refuse to delete anything that is not unmistakably a CardVault install folder.
safe_install_dir() {
  local d=${1:-}
  [[ -n $d && $d == /* ]] || return 1
  d=$(realpath -m "$d")
  case $d in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var) return 1 ;;
  esac
  [[ $d != "$(realpath -m "${HOME:-/root}")" ]] || return 1
  [[ -f $d/package.json && -f $d/pnpm-workspace.yaml ]] || return 1
  grep -q '"name": "cardvault"' "$d/package.json" 2>/dev/null
}

# Only CardVault's own keys: Redis may be shared with other software.
clear_redis_queues() {
  have redis-cli || return 0
  local url pattern
  url=$(env_get REDIS_URL); url=${url:-redis://127.0.0.1:6379}
  for pattern in 'bull:identification:*' 'bull:research:*' 'bull:pricing:*' 'bull:image:*' 'bull:manual-review:*' 'bull:maintenance:*' 'cardvault:*'; do
    redis-cli -u "$url" --scan --pattern "$pattern" 2>/dev/null | xargs -r -n 200 redis-cli -u "$url" DEL >/dev/null 2>&1 || true
  done
}

wipe_backup() {
  local dest=$1 ok_all=yes
  as_root install -d -m 0700 "$dest"
  if have pg_dump && EXPECTED_SECONDS=30 run "Back up database" as_root pg_dump --format=custom --compress=9 --no-owner --file "$dest/cardvault.dump" "$(env_get DATABASE_URL)"; then :; else ok_all=no; fi
  if [[ -d $INSTALL_DIR/storage ]]; then
    EXPECTED_SECONDS=60 run "Back up card images" as_root tar -C "$INSTALL_DIR/storage" -czf "$dest/storage.tar.gz" . || ok_all=no
  fi
  if [[ -d $INSTALL_DIR/backups ]] && [[ -n $(find "$INSTALL_DIR/backups" -type f -print -quit 2>/dev/null) ]]; then
    EXPECTED_SECONDS=30 run "Keep earlier exports" as_root cp -a "$INSTALL_DIR/backups" "$dest/previous-backups" || ok_all=no
  fi
  [[ $ok_all == yes ]]
}

wipe_restore() {
  local src=$1
  section "Restore backup"
  stop_services
  if [[ -f $src/cardvault.dump ]]; then
    if EXPECTED_SECONDS=60 run "Restore database" as_root pg_restore --clean --if-exists --no-owner --dbname "$(env_get DATABASE_URL)" "$src/cardvault.dump"; then
      # the backup may predate newer migrations
      EXPECTED_SECONDS=30 run "Update database schema" bash -c "cd '$INSTALL_DIR' && pnpm db:migrate" || true
    else
      warn "Database restore reported errors; check ${RUN_LOG}."
    fi
  fi
  if [[ -f $src/storage.tar.gz ]]; then
    mkdir -p "$INSTALL_DIR/storage"
    EXPECTED_SECONDS=60 run "Restore card images" as_root tar -C "$INSTALL_DIR/storage" -xzf "$src/storage.tar.gz" || warn "Image restore reported errors."
  fi
  if [[ -d $src/previous-backups ]]; then
    mkdir -p "$INSTALL_DIR/backups"
    as_root cp -a "$src/previous-backups/." "$INSTALL_DIR/backups/" || true
  fi
  as_root chown -R "$INSTALL_USER" "$INSTALL_DIR/storage" "$INSTALL_DIR/backups" 2>/dev/null || true
  start_services
  ok "Backup restored. Sign in with the accounts from the backup."
}

wipe_reinstall() {
  section "Wipe and reinstall"
  if ! safe_install_dir "$INSTALL_DIR"; then
    err "Refusing to wipe '${INSTALL_DIR}': it does not look like a CardVault install folder."
    pause; return
  fi
  warn "This permanently removes the current CardVault installation:"
  printf '    • %s  (program files, .env settings, card images, exports)\n' "$INSTALL_DIR"
  printf '    • the "cardvault" database: all collections, scans, users and price history\n'
  printf '    • CardVault services, nginx site, Caddy site, LAN firewall rules and queued jobs\n'
  info "Kept: system packages (Node.js, PostgreSQL, Redis, nginx, Caddy), Caddy's local"
  info "certificate authority (phones stay trusted) and this console."
  info "Only want an empty collection? Use option 8 (Clear database) instead."
  printf '\n'

  local stamp dest='' backed=no
  stamp=$(date +%Y%m%d-%H%M%S)
  if ask "Save a backup of the database and card images first (recommended)?" y; then
    dest="$WIPE_BACKUP_ROOT/wipe-$stamp"
    if wipe_backup "$dest"; then
      backed=yes
      ok "Backup saved outside the install folder: ${dest}"
    else
      warn "The backup did not complete (details in ${RUN_LOG}). Partial files are in ${dest}."
      ask "Wipe anyway?" n || { warn "Wipe cancelled. Nothing was removed."; pause; return; }
    fi
  elif [[ -n $(find "$INSTALL_DIR/backups" -type f -print -quit 2>/dev/null) ]]; then
    warn "Earlier exports in ${INSTALL_DIR}/backups will be deleted too."
  fi

  if ! confirm_type WIPE; then
    warn "Wipe cancelled. Nothing was removed."
    [[ $backed == yes ]] && info "The backup just taken is kept at ${dest}"
    pause; return
  fi

  section "Removing the current installation"
  task "Stopping services"
  stop_services
  if have_systemd; then
    as_root systemctl disable --now cardvault-api cardvault-worker cardvault-lan >/dev/null 2>&1 || true
    as_root rm -f /etc/systemd/system/cardvault-api.service /etc/systemd/system/cardvault-worker.service /etc/systemd/system/cardvault-lan.service
    as_root systemctl daemon-reload || true
  fi
  ok "Services removed"

  task "Clearing queued jobs"
  clear_redis_queues
  ok "Queued jobs cleared"

  task "Removing the database"
  pg_admin dropdb --if-exists --force cardvault >/dev/null 2>&1 || pg_admin dropdb --if-exists cardvault >/dev/null 2>&1 || true
  pg_admin psql -qc 'DROP ROLE IF EXISTS cardvault;' >/dev/null 2>&1 || true
  ok "Database removed"

  task "Removing web server and firewall settings"
  remove_firewall_rules || true
  as_root rm -f /etc/nginx/conf.d/cardvault.conf
  if have nginx && as_root nginx -t >/dev/null 2>&1; then
    as_root systemctl reload nginx >/dev/null 2>&1 || true
  fi
  if [[ -f /etc/caddy/Caddyfile ]] && grep -q 'Generated by cardvault-setup' /etc/caddy/Caddyfile 2>/dev/null; then
    as_root rm -f /etc/caddy/Caddyfile
    as_root systemctl disable --now caddy >/dev/null 2>&1 || true
  fi
  ok "Web server and firewall settings removed"

  task "Deleting ${INSTALL_DIR}"
  as_root rm -rf -- "$(realpath -m "$INSTALL_DIR")"
  as_root rm -f "$CONF_FILE"
  ok "Installation removed"

  # Reinstall from scratch with the usual questions.
  STEP_NO=0
  fresh_install
  if [[ -f $INSTALL_DIR/scripts/install.sh ]]; then install_manager "$INSTALL_DIR/scripts/install.sh"; fi

  if [[ $backed == yes ]]; then
    if ask "Restore the backup you saved before wiping?" y; then
      wipe_restore "$dest"
    else
      info "Backup kept at ${dest}"
    fi
    pause
  fi
}

# ---------------------------------------------------------------------------
# Menu
# ---------------------------------------------------------------------------
menu() {
  local -a items=(
    'Service status / URL|what runs, and where to reach CardVault'
    'Start services|api, worker and web server'
    'Stop services|everything stays installed'
    'Restart services|after configuration changes'
    'View live logs|follow API or worker output'
    'Export database|save a timestamped .dump backup'
    'Import database|restore from a saved backup'
    'Clear database (reset)|empty collections, scans and users'
    'Export card images|tar archive of the storage folder'
    'Import card images|restore a saved image archive'
    'Change user password|also signs the user out'
    'Create user|optionally an administrator'
    'Edit configuration (.env)|then restart services'
    'Check for updates / upgrade|pull the tracked branch'
    'Installation details|paths, commit and service state'
    'LAN access / addresses|firewall, hostname, WEB_ORIGIN'
    'Network diagnostics|why a phone cannot connect'
    'HTTPS (local certificate)|Caddy with a local CA'
    'Wipe and reinstall|destroys all data'
    'Exit|leave CardVault running'
  )
  local MENU_SEL=0
  while true; do
    local sel
    if (( TERMINAL_UI )) && [[ ${CARDVAULT_VERBOSE:-0} != 1 ]]; then
      local picked
      if picked=$(tui_menu 'CardVault management console' "$MENU_SEL" "${items[@]}"); then
        MENU_SEL=$picked
        sel=$(( picked + 1 ))
      else
        sel=20   # Esc at the top level = the Exit entry
      fi
    else
      clear_content
      banner
      section "CardVault management console"
      local i
      for (( i = 0; i < ${#items[@]}; i++ )); do
        printf '  %s%2d)%s %s\n' "$CYAN" $(( i + 1 )) "$RESET" "${items[$i]%%|*}"
      done
      printf '\n'
      sel=$(prompt_value "Select an option" 20)
    fi
    case $sel in
      1) tui_report 'Service status' service_status ;;
      2) tui_action 'Starting services' start_services ;;
      3) tui_action 'Stopping services' stop_services ;;
      4) tui_action 'Restarting services' restart_services ;;
      5) tui_external 'Live logs' view_logs ;;
      6) tui_action 'Export database' db_export ;;
      7) tui_action 'Import database' db_import ;;
      8) tui_action 'Clear database' db_clear ;;
      9) tui_action 'Export card images' images_export ;;
      10) tui_action 'Import card images' images_import ;;
      11) tui_action 'Change user password' change_password ;;
      12) tui_action 'Create user' create_user ;;
      13) tui_external 'Edit configuration' edit_config ;;
      14) tui_action 'Checking for updates' check_for_updates ;;
      15) tui_report 'Installation details' show_info ;;
      16) lan_menu ;;
      17) tui_report 'Network diagnostics' lan_diagnose ;;
      18) https_menu ;;
      19) tui_action 'Wipe and reinstall' wipe_reinstall ;;
      20)
        if (( TERMINAL_UI )); then
          tui_screen_close
          printf '\n'
        else
          section 'Goodbye'
        fi
        if services_running; then
          ok 'CardVault is left running in the background.'
        else
          info 'CardVault services are stopped.'
        fi
        exit 0
        ;;
      *) warn "Unknown option: ${sel}" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
trap 'rc=$?; [[ $rc -eq 0 ]] || err "Unexpected failure (exit ${rc}) at line ${LINENO}"' ERR
trap 'printf "\n"; warn "Interrupted."; exit 130' INT
trap cleanup_console EXIT

main() {
  case ${1:-} in
    --tui-demo)
      # hidden: preview every TUI screen without touching the system
      init_console
      tui_demo
      exit 0
      ;;
    --refresh-lan)
      init_console
      detect_os
      ensure_sudo
      if find_install; then refresh_lan; else warn "No CardVault installation found."; fi
      exit 0
      ;;
    -h|--help)
      banner
      cat <<EOF
Usage: cardvault-setup [options]

Options:
  -h, --help    Show this help
  --refresh-lan Refresh hostname/IP/nginx/firewall (used by the boot unit)

Environment overrides:
  CARDVAULT_REPO   Git URL to clone (default: ${REPO})
  CARDVAULT_BRANCH Branch to track    (default: ${BRANCH_DEFAULT})
  CARDVAULT_DIR    Install directory  (default: /opt/cardvault)
  CARDVAULT_PORT   Web port           (default: 8080)
  CARDVAULT_USER   Account to run services as
  CARDVAULT_VERBOSE=1  Stream command output instead of progress bars
  CARDVAULT_LOG    Log file (default: /tmp/cardvault-setup.log)
  NO_COLOR         Disable coloured output
EOF
      exit 0
      ;;
  esac

  init_console
  detect_os
  ensure_sudo

  if find_install; then
    banner
    section "Existing installation"
    ok "Found CardVault at ${INSTALL_DIR}"
    info "Branch: ${TRACK_BRANCH}  •  Port: ${WEB_PORT}"
    info "Opening the management menu…"
    menu
  else
    banner
    section "Not installed"
    info "CardVault was not found on this machine."
    if [[ ! -t 0 ]]; then
      info "Run this script in an interactive terminal to install."
      exit 0
    fi
    if ask "Install CardVault now?" y; then
      fresh_install
    else
      info "Nothing changed. Run this script again whenever you're ready."
      exit 0
    fi
  fi
}

main "$@"
