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
else
  BOLD=''; DIM=''; RESET=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; WHITE=''
fi

ok()   { printf '  %s✔%s %s\n' "$GREEN" "$RESET" "$*"; }
info() { printf '  %s•%s %s\n' "$CYAN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
err()  { printf '  %s✖%s %s\n' "$RED" "$RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }

section() {
  printf '\n%s%s━━ %s ━━%s\n' "$BOLD" "$BLUE" "$*" "$RESET"
}

RUN_LOG=${CARDVAULT_LOG:-/tmp/cardvault-setup.log}
STEP_NO=0
STEP_TOTAL=8
BAR_WIDTH=28

progress_bar() {
  local pct=$1 width=${2:-$BAR_WIDTH} i bar=''
  (( pct < 0 )) && pct=0
  (( pct > 100 )) && pct=100
  for ((i = 0; i < width; i++)); do
    if (( i < pct * width / 100 )); then bar+="${GREEN}█${RESET}"
    else bar+="${DIM}░${RESET}"; fi
  done
  printf '[%s]' "$bar"
}

step() {
  STEP_NO=$((STEP_NO + 1))
  local pct=$(( STEP_NO * 100 / STEP_TOTAL ))
  printf '\n%s[%d/%d]%s %s%s%s\n' "$CYAN" "$STEP_NO" "$STEP_TOTAL" "$RESET" "$BOLD" "$*" "$RESET"
  printf '  %sOverall%s ' "$DIM" "$RESET"
  progress_bar "$pct" 24
  printf ' %3d%%\n' "$pct"
}

task() { printf '    %s↳%s %s\n' "$DIM" "$RESET" "$*"; }

# Runs a task with an animated progress bar. Set EXPECTED_SECONDS before calling
# to make the bar fill at a realistic pace; it holds at 95% if a task runs long.
run() {
  local label=$1 expected=${EXPECTED_SECONDS:-30} start=$SECONDS pid rc=0
  shift
  printf '  %s→%s %s\n' "$DIM" "$RESET" "$label"
  if [[ ${CARDVAULT_VERBOSE:-0} == 1 ]]; then
    set +e
    "$@" 2>&1 | tee -a "$RUN_LOG"
    rc=${PIPESTATUS[0]}
    set -e
  else
    "$@" >>"$RUN_LOG" 2>&1 &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      local elapsed=$(( SECONDS - start ))
      local pct=$(( elapsed * 100 / expected ))
      (( pct > 95 )) && pct=95
      printf '\r  '
      progress_bar "$pct"
      printf ' %3d%%  %02d:%02d' "$pct" "$(( elapsed / 60 ))" "$(( elapsed % 60 ))"
      sleep 0.2
    done
    if wait "$pid"; then rc=0; else rc=$?; fi
    printf '\r\033[2K'
  fi
  if (( rc == 0 )); then
    ok "$label  ${DIM}($(( SECONDS - start ))s)${RESET}"
  else
    err "$label failed (exit ${rc})"
    if [[ -s $RUN_LOG ]]; then
      printf '  %sLast log lines:%s\n' "$DIM" "$RESET" >&2
      tail -n 15 "$RUN_LOG" >&2
    fi
    return "$rc"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

ask() {
  local prompt=$1 default=${2:-y} ans
  if [[ ! -t 0 ]]; then printf '%s\n' "$prompt (non-interactive: using default)" >&2; [[ $default == y ]]; return; fi
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
  if [[ ! -t 0 ]]; then printf '%s\n' "$prompt (non-interactive: using default)" >&2; printf '%s' "$default"; return; fi
  if [[ -n $default ]]; then printf '  %s?%s %s %s[%s]%s ' "$BLUE" "$RESET" "$prompt" "$DIM" "$default" "$RESET" >&2
  else printf '  %s?%s %s ' "$BLUE" "$RESET" "$prompt" >&2; fi
  IFS= read -r out || true
  printf '%s' "${out:-$default}"
}

prompt_secret() {
  local prompt=$1 out
  printf '  %s?%s %s ' "$BLUE" "$RESET" "$prompt" >&2
  IFS= read -rs out || true
  printf '\n' >&2
  printf '%s' "$out"
}

confirm_type() {
  local word=$1 ans
  printf '  Type %s%s%s to confirm: ' "$BOLD" "$word" "$RESET" >&2
  IFS= read -r ans || true
  [[ $ans == "$word" ]]
}

pause() {
  if [[ -t 0 ]]; then printf '  %sPress Enter to continue…%s' "$DIM" "$RESET" >&2; read -r _ || true; fi
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

  if ! have pnpm || [[ $(pnpm --version 2>/dev/null | cut -d. -f1) -lt 10 ]]; then
    task "Installing the pnpm package manager"
    EXPECTED_SECONDS=60 run "Install pnpm 10" as_root npm install -g pnpm@10.12.1
  fi
  ok "Node $(node -v), pnpm $(pnpm --version), $(pg_config --version 2>/dev/null || echo 'PostgreSQL installed')"
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
# Installed-state helpers
# ---------------------------------------------------------------------------
write_config() {
  local dir=$1 branch=$2 user=$3 port=$4
  as_root tee "$CONF_FILE" >/dev/null <<EOF
# Generated by cardvault-setup — safe to edit.
INSTALL_DIR="${dir}"
TRACK_BRANCH="${branch}"
INSTALL_USER="${user}"
WEB_PORT="${port}"
EOF
}

load_config() {
  [[ -f $CONF_FILE ]] || return 1
  # shellcheck disable=SC1090
  . "$CONF_FILE"
  [[ -n ${INSTALL_DIR:-} && -d $INSTALL_DIR ]] || return 1
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
      write_config "$INSTALL_DIR" "$TRACK_BRANCH" "$INSTALL_USER" "$WEB_PORT"
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
  local tmp; tmp=$(mktemp)
  cat >"$tmp" <<EOF
# Generated by cardvault-setup. Local-network only.
server {
    listen ${WEB_PORT};
    server_name _;
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
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
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
  as_root install -m 0644 "$tmp" /etc/nginx/conf.d/cardvault.conf
  rm -f "$tmp"
  if as_root nginx -t >/dev/null 2>&1; then
    ok "nginx site configured on port ${WEB_PORT}"
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

enable_boot() {
  have_systemd || { warn "Boot start requires systemd; skipping."; return; }
  as_root systemctl enable cardvault-api cardvault-worker nginx postgresql redis-server >/dev/null 2>&1 || true
  ok "Services enabled at boot"
}

configure_firewall() {
  if have ufw && as_root ufw status 2>/dev/null | grep -q '^Status: active'; then
    if ask "Allow LAN devices to reach port ${WEB_PORT} through ufw?" y; then
      for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
        as_root ufw allow from "$net" to any port "$WEB_PORT" proto tcp comment 'CardVault LAN' >/dev/null 2>&1 || true
      done
      ok "LAN access allowed on port ${WEB_PORT} (private ranges only)"
    fi
  fi
}

service_status() {
  printf '  %-28s %s\n' 'SERVICE' 'STATUS'
  for s in cardvault-api cardvault-worker nginx postgresql redis-server; do
    local state='n/a'
    if have_systemd; then state=$(systemctl is-active "$s" 2>/dev/null || true); fi
    if [[ $state == active ]]; then printf '  %-28s %s%s%s\n' "$s" "$GREEN" "$state" "$RESET"
    else printf '  %-28s %s%s%s\n' "$s" "$YELLOW" "${state:-not installed}" "$RESET"; fi
  done
  printf '\n  %sURL:%s http://localhost:%s\n' "$DIM" "$RESET" "$WEB_PORT"
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
  if have git && EXPECTED_SECONDS=90 run "Clone repository" git clone --depth 1 --branch "$TRACK_BRANCH" "$REPO" "$INSTALL_DIR.tmp"; then
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
  task "Generating session secret and database password"
  task "Writing ${INSTALL_DIR}/.env"
  cat >"$INSTALL_DIR/.env.tmp" <<EOF
NODE_ENV=production
DATABASE_URL=postgres://cardvault:${DB_PASS}@127.0.0.1:5432/cardvault
REDIS_URL=redis://127.0.0.1:6379
SESSION_SECRET=${SESSION_SECRET}
STORAGE_DIR=${INSTALL_DIR}/storage
API_PORT=3000
API_HOST=127.0.0.1
COOKIE_SECURE=false
WEB_ORIGIN=http://localhost:${WEB_PORT}
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
  write_config "$INSTALL_DIR" "$TRACK_BRANCH" "$INSTALL_USER" "$WEB_PORT"
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
  task "Configuring nginx on port ${WEB_PORT}"
  install_nginx
  if [[ -n $SCRIPT_PATH ]]; then
    install_manager "$SCRIPT_PATH"
  else
    warn "Started via a pipe, so no manager copy was installed. Save this script and run it again to get '${MGR}'."
  fi

  step "Starting CardVault"
  if [[ $boot == yes ]]; then task "Enabling services at boot"; enable_boot; fi
  task "Checking the local firewall"
  configure_firewall
  task "Starting API, worker and web server"
  restart_services
  info "Waiting for services to become ready…"
  EXPECTED_SECONDS=10 run "Health check" sleep 3
  service_status

  section "Installation complete"
  ok "CardVault is running at http://localhost:${WEB_PORT}"
  info "On other devices: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${WEB_PORT}"
  info "Management console: ${MGR}"
  info "Phone camera: use HTTPS or 'Upload photo instead' on plain HTTP."
  pause
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
  count=$(cd "$INSTALL_DIR" && git rev-list --count "HEAD..origin/${branch}" 2>/dev/null || echo 0)
  if [[ $count == 0 ]]; then ok "Already up to date."; return; fi

  warn "${count} new commit(s) available:"
  (cd "$INSTALL_DIR" && git --no-pager log --oneline "HEAD..origin/${branch}" | head -12) || true

  if ask "Upgrade to the latest version now?" n; then
    do_upgrade "$branch"
  else
    warn "Upgrade declined. Opening the management menu."
  fi
}

do_upgrade() {
  local branch=$1
  section "Upgrading CardVault"
  if [[ -n $(cd "$INSTALL_DIR" && git status --porcelain 2>/dev/null) ]]; then
    warn "Local source files have been modified."
    ask "Discard local source changes and upgrade?" n || { warn "Upgrade cancelled."; return; }
    (cd "$INSTALL_DIR" && git reset --hard "origin/${branch}")
  fi
  run "Fetch and apply updates" bash -c "cd '$INSTALL_DIR' && git pull --ff-only origin '$branch'"
  run "Update dependencies" bash -c "cd '$INSTALL_DIR' && pnpm install --frozen-lockfile"
  run "Rebuild application" bash -c "cd '$INSTALL_DIR' && pnpm build"
  run "Apply migrations" bash -c "cd '$INSTALL_DIR' && pnpm db:migrate && pnpm db:seed"
  write_config "$INSTALL_DIR" "$branch" "$INSTALL_USER" "$WEB_PORT"
  install_nginx
  if [[ -f $INSTALL_DIR/scripts/install.sh ]]; then install_manager "$INSTALL_DIR/scripts/install.sh"; fi
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
  local i=1
  for f in "${files[@]}"; do printf '  %s[%d]%s %s\n' "$CYAN" "$i" "$RESET" "${f##*/}"; i=$((i+1)); done
  local n; n=$(prompt_value "Choose a backup number" 1)
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
  local i=1
  for u in "${users[@]}"; do printf '  %s[%d]%s %s\n' "$CYAN" "$i" "$RESET" "$u"; i=$((i+1)); done
  local n; n=$(prompt_value "Choose a user number" 1)
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
  local i=1
  for f in "${files[@]}"; do printf '  %s[%d]%s %s\n' "$CYAN" "$i" "$RESET" "${f##*/}"; i=$((i+1)); done
  local n; n=$(prompt_value "Choose an archive number" 1)
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
  printf '  %s[1]%s API   %s[2]%s Worker\n' "$CYAN" "$RESET" "$CYAN" "$RESET"
  [[ $(prompt_value "Which service" 1) == 2 ]] && unit=cardvault-worker
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

# ---------------------------------------------------------------------------
# Menu
# ---------------------------------------------------------------------------
menu() {
  while true; do
    clear 2>/dev/null || true
    banner
    section "CardVault management console"
    printf '  %s 1)%s Service status / URL\n' "$CYAN" "$RESET"
    printf '  %s 2)%s Start services\n' "$CYAN" "$RESET"
    printf '  %s 3)%s Stop services\n' "$CYAN" "$RESET"
    printf '  %s 4)%s Restart services\n' "$CYAN" "$RESET"
    printf '  %s 5)%s View live logs\n' "$CYAN" "$RESET"
    printf '\n'
    printf '  %s 6)%s Export database\n' "$CYAN" "$RESET"
    printf '  %s 7)%s Import database\n' "$CYAN" "$RESET"
    printf '  %s 8)%s Clear database (reset)\n' "$CYAN" "$RESET"
    printf '  %s 9)%s Export card images\n' "$CYAN" "$RESET"
    printf '  %s10)%s Import card images\n' "$CYAN" "$RESET"
    printf '\n'
    printf '  %s11)%s Change user password\n' "$CYAN" "$RESET"
    printf '  %s12)%s Create user\n' "$CYAN" "$RESET"
    printf '  %s13)%s Edit configuration (.env)\n' "$CYAN" "$RESET"
    printf '  %s14)%s Check for updates / upgrade\n' "$CYAN" "$RESET"
    printf '  %s15)%s Installation details\n' "$CYAN" "$RESET"
    printf '\n'
    printf '  %s 0)%s Exit\n\n' "$CYAN" "$RESET"
    local c; c=$(prompt_value "Select an option" 0)
    case $c in
      1) section 'Service status'; service_status; pause ;;
      2) section 'Starting services'; start_services; ok 'Started.'; pause ;;
      3) section 'Stopping services'; stop_services; ok 'Stopped.'; pause ;;
      4) section 'Restarting services'; restart_services; ok 'Restarted.'; pause ;;
      5) view_logs ;;
      6) db_export ;;
      7) db_import ;;
      8) db_clear ;;
      9) images_export ;;
      10) images_import ;;
      11) change_password ;;
      12) create_user ;;
      13) edit_config ;;
      14) check_for_updates; pause ;;
      15) show_info ;;
      0) section 'Goodbye'; ok 'CardVault is left running in the background.'; exit 0 ;;
      *) warn "Unknown option: ${c}" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
trap 'rc=$?; [[ $rc -eq 0 ]] || err "Unexpected failure (exit ${rc}) at line ${LINENO}"' ERR
trap 'printf "\n"; warn "Interrupted."; exit 130' INT

main() {
  case ${1:-} in
    -h|--help)
      banner
      cat <<EOF
Usage: cardvault-setup [options]

Options:
  -h, --help    Show this help

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
