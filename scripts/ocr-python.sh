#!/usr/bin/env bash
#
# CardVault — prepare the Python that trains the OCR line reader
# (tools/ocr-trainer). Creates a virtual environment with CPU PyTorch, numpy,
# Pillow, onnx and onnxruntime, then prints the interpreter path.
#
#   bash scripts/ocr-python.sh              # create or repair the environment
#   bash scripts/ocr-python.sh --check      # exit 0 only if it can train now
#   bash scripts/ocr-python.sh --status     # what is installed (always exit 0)
#   bash scripts/ocr-python.sh --print-python
#
# Used by scripts/install.sh, the worker image (docker/Dockerfile) and the
# in-app "Set up the OCR trainer" button (Developer → OCR Lab → Models → Train).
#
# Environment overrides:
#   OCR_TRAIN_VENV          where the environment lives (default: $HOME/ocr-venv)
#   OCR_TRAIN_TORCH_INDEX   CPU wheel index for PyTorch (default: pytorch.org/whl/cpu)
#   OCR_TRAIN_REQUIREMENTS  requirements file (default: this repo's
#                           tools/ocr-trainer/requirements.txt)
#   OCR_TRAIN_BASE_PYTHON   interpreter used to create the environment
#   OCR_TRAIN_OFFLINE=1     never touch the network; only check what is there
#
# Exit codes: 0 ready · 1 failed · 2 no usable python3 to build from.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(dirname "$SCRIPT_DIR")

# When run beside a CardVault install (scripts/install.sh does this), its .env
# is authoritative: OCR_TRAIN_VENV / OCR_TRAIN_TORCH_INDEX set there must win
# over the environment, which is the other way round for the app itself.
if [[ -f $REPO_DIR/.env ]]; then
  while IFS='=' read -r key value; do
    [[ $key =~ ^OCR_TRAIN_(VENV|TORCH_INDEX)$ ]] || continue
    value=${value%$'\r'}
    [[ -n $value ]] && printf -v "$key" '%s' "$value"
  done <"$REPO_DIR/.env"
fi

REQUIREMENTS=${OCR_TRAIN_REQUIREMENTS:-$REPO_DIR/tools/ocr-trainer/requirements.txt}
TORCH_INDEX=${OCR_TRAIN_TORCH_INDEX:-https://download.pytorch.org/whl/cpu}
VENV=${OCR_TRAIN_VENV:-${HOME:-/tmp}/ocr-venv}
VERIFY='import torch, numpy, PIL, onnx, onnxruntime'

MODE=install
case ${1:-} in
  --check) MODE=check ;;
  --print-python) MODE=print ;;
  --status) MODE=status ;;
  -h|--help)
    sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  '') ;;
  *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
esac

say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------------------
# Find a python3 that can create virtual environments
# ---------------------------------------------------------------------------
base_python() {
  local c
  for c in "${OCR_TRAIN_BASE_PYTHON:-}" python3 python; do
    [[ -n $c ]] || continue
    command -v "$c" >/dev/null 2>&1 || continue
    "$c" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null || continue
    printf '%s' "$c"
    return 0
  done
  return 1
}

versions() {
  "$1" - <<'PY' 2>/dev/null
import importlib
out = []
for name in ("torch", "numpy", "PIL", "onnx", "onnxruntime"):
    try:
        m = importlib.import_module(name)
        v = getattr(m, "__version__", "?")
    except Exception:
        v = None
    out.append(f"{name}={'missing' if v is None else v}")
print(" ".join(out))
PY
}

ready() { [[ -x $1 ]] && "$1" -c "$VERIFY" >/dev/null 2>&1; }

if [[ $MODE == check || $MODE == print || $MODE == status ]]; then
  if ready "$VENV/bin/python"; then
    if [[ $MODE == print ]]; then printf '%s\n' "$VENV/bin/python"; else say "ready $VENV/bin/python $(versions "$VENV/bin/python")"; fi
    exit 0
  fi
  if [[ $MODE == status ]]; then say "not ready $VENV/bin/python"; exit 0; fi
  [[ $MODE == check ]] && say "not ready $VENV/bin/python" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Install (or repair) the environment
# ---------------------------------------------------------------------------
if ready "$VENV/bin/python"; then
  say "ready $VENV/bin/python $(versions "$VENV/bin/python")"
  exit 0
fi

PY=$(base_python) || {
  say "No python3 (3.9 or newer) was found. Install Python 3 first:"
  say "  Debian/Ubuntu: sudo apt-get install python3 python3-venv"
  say "  Fedora/RHEL:   sudo dnf install python3"
  say "  Arch:          sudo pacman -S python"
  exit 2
}

if [[ ! -x $VENV/bin/python ]]; then
  say "==> creating the virtual environment in $VENV (with $PY)"
  mkdir -p "$(dirname "$VENV")" || { say "Cannot create $(dirname "$VENV")."; exit 1; }
  if ! "$PY" -m venv "$VENV" 2>&1 | tail -n 5; then :; fi
  if [[ ! -x $VENV/bin/python ]]; then
    say "Could not create a virtual environment. On Debian/Ubuntu install python3-venv:"
    say "  sudo apt-get install python3-venv"
    exit 1
  fi
else
  say "==> reusing the virtual environment in $VENV"
fi

PY_BIN=$VENV/bin/python
[[ -x $PY_BIN ]] || PY_BIN=$VENV/bin/python3
pip() { PIP_NO_CACHE_DIR=1 "$PY_BIN" -m pip "$@"; }

if [[ ${OCR_TRAIN_OFFLINE:-0} != 1 ]]; then
  # a current pip resolves the CPU wheels faster and falls back cleanly
  pip install --quiet --upgrade pip >/dev/null 2>&1 || true

  # torch first, from the CPU-only index: the default wheel bundles CUDA and is
  # several gigabytes, which a home server neither needs nor can usually spare
  if ! "$PY_BIN" -c 'import torch' >/dev/null 2>&1; then
    say "==> installing PyTorch (CPU build; the first run downloads a few hundred MB)"
    say "    from $TORCH_INDEX"
    # a few retries, but fail over reasonably fast when the host is unreachable
    if ! pip install --quiet --retries 2 --timeout 20 --index-url "$TORCH_INDEX" torch; then
      say "==> the CPU index was not reachable; trying the default package index"
      say "    (this build is much larger — set OCR_TRAIN_TORCH_INDEX to use a mirror)"
      if ! pip install --quiet --retries 2 --timeout 20 torch; then
        say "Could not install PyTorch. Check this server's internet access, or point"
        say "OCR_TRAIN_TORCH_INDEX at a local wheel mirror."
        exit 1
      fi
    fi
  fi
fi

# torch is already installed above (CPU build). Installing the requirements file
# as-is could pull the default, CUDA-bundled build when its pin is newer than
# the CPU wheel, so drop that one line and keep everything else.
REQ_WITHOUT_TORCH=$(mktemp "${TMPDIR:-/tmp}/cardvault-ocr-req.XXXXXX")
trap 'rm -f "$REQ_WITHOUT_TORCH"' EXIT
if [[ -f $REQUIREMENTS ]]; then
  grep -viE '^[[:space:]]*(torch)([<>=!~ ]|$)' "$REQUIREMENTS" >"$REQ_WITHOUT_TORCH" || true
  say "==> installing the trainer's packages from $(basename "$REQUIREMENTS")"
  req_log=$(mktemp "${TMPDIR:-/tmp}/cardvault-ocr-log.XXXXXX")
  if ! PIP_NO_CACHE_DIR=1 "$PY_BIN" -m pip install --quiet -r "$REQ_WITHOUT_TORCH" >"$req_log" 2>&1; then
    # pip's own message says what failed (usually the network)
    tail -n 12 "$req_log" >&2
    rm -f "$req_log"
    say "Installing $REQUIREMENTS failed."
    exit 1
  fi
  rm -f "$req_log"
fi

if ready "$PY_BIN"; then
  say "python $PY_BIN"
  say "ready $PY_BIN $(versions "$PY_BIN")"
  exit 0
fi

say "The environment was created but cannot import everything the trainer needs:"
say "  $PY_BIN -c '$VERIFY'"
exit 1
