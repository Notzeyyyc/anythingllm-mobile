#!/usr/bin/env bash
# AnythingPocket installer — one command setup of the sidecar ("Harness Companion").
# Usage: bash install.sh [--dry-run | --explain]
# Robust, idempotent, no secrets touched. See --explain for what it does.
set -euo pipefail

REPO_URL="${APO_REPO_URL:-https://github.com/Notzeyyyc/anythingllm-mobile.git}"
INSTALL_DIR="${HOME}/.anythingpocket"
MIN_DISK_MB=500 # sidecar node_modules + SQLite data fit easily under this

MODE="run"
case "${1:-}" in
  "") MODE="run" ;;
  --dry-run) MODE="dry" ;;
  --explain) MODE="explain" ;;
  *) echo "Usage: bash install.sh [--dry-run | --explain]"; exit 2 ;;
esac

if [ "$MODE" = "explain" ]; then
cat <<'EOF'
Apa yang installer ini lakukan / What this installer does:

Installer ini menyiapkan komponen server (sidecar) AnythingPocket di komputer
atau VPS kamu. Sidecar adalah program Node.js yang menjalankan agent harness
penuh dan berkomunikasi dengan HP kamu via WebSocket lokal. Installer tidak
menginstal Node secara otomatis, tidak menyentuh secrets, dan tidak menjalankan
layanan latar — kamu yang memulai server secara manual di langkah terakhir.

Langkah / steps:
  1. Cek prasyarat: git, Node >= 22.5, ruang disk >= 500 MB.
  2. Clone repo ke ~/.anythingpocket (atau git pull kalau sudah ada — idempotent).
  3. Install dependency runtime sidecar: npm ci --omit=dev (tanpa dev deps).
  4. Buat direktori data (SQLite) dan workspace.
  5. Jalankan `doctor` sebagai verifikasi akhir (exit 0 = sehat).

Path yang disentuh / paths touched:
  - ~/.anythingpocket            (clone repo; dibuat atau di-update)
  - ~/.anythingpocket/sidecar/node_modules/   (npm ci --omit=dev)
  - ~/.anythingpocket/sidecar/data/           (DB SQLite; dibuat)
  - ~/.anythingpocket/sidecar/workspace/      (sandbox file tools; dibuat)
Tidak ada path lain, tidak ada file di luar itu.
EOF
exit 0
fi

run() { # print + execute (or just print in dry-run)
  echo "+ $*"
  [ "$MODE" = "dry" ] || "$@"
}

echo "== AnythingPocket installer =="
fail=0
for cmd in git node npm; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "[OK] $cmd: $(command -v "$cmd")"
  else
    echo "[FAIL] $cmd tidak ada / missing."
    [ "$cmd" = "node" ] && cat <<'EOF'
  Node.js belum terpasang / Node.js not installed.
  Install Node LTS (>= 22.5) terlebih dulu, lalu jalankan installer lagi:
    https://nodejs.org/  (LTS installer)
    atau via nvm:  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install --lts
  (Installer ini tidak menginstal Node otomatis — pakai cara resmi di atas.)
EOF
    fail=1
  fi
done

node_ok() { [ "$(node -p 'parseInt(process.versions.node) >= 22.5')" = "true" ]; }
if command -v node >/dev/null 2>&1 && ! node_ok; then
  echo "[FAIL] Node $(node --version) terlalu lama / too old — butuh / need >= 22.5 (node:sqlite). Upgrade ke Node LTS: https://nodejs.org/"
  fail=1
fi

avail_mb=$(df -Pm "${HOME}" | awk 'NR==2 {print $4}')
if [ "${avail_mb:-0}" -lt "$MIN_DISK_MB" ]; then
  echo "[FAIL] Ruang disk kurang / low disk space: ${avail_mb} MB tersedia, butuh / need ${MIN_DISK_MB} MB."
  fail=1
else
  echo "[OK] Disk: ${avail_mb} MB tersedia / available."
fi
[ "$fail" = "0" ] || exit 1
[ "$MODE" = "dry" ] && echo "(dry-run: tidak ada eksekusi / no execution below)" && echo

# 2. clone or update (idempotent)
if [ -d "$INSTALL_DIR/.git" ]; then
  run git -C "$INSTALL_DIR" pull --ff-only
else
  run git clone "$REPO_URL" "$INSTALL_DIR"
fi

# 3-4. deps + dirs
if [ -f "$INSTALL_DIR/sidecar/package-lock.json" ]; then
  run npm --prefix "$INSTALL_DIR/sidecar" ci --omit=dev
else
  echo "[WARN] package-lock.json tidak ada / missing — fallback ke npm install (kurang reproducible)."
  run npm --prefix "$INSTALL_DIR/sidecar" install --omit=dev
fi
run mkdir -p "$INSTALL_DIR/sidecar/data" "$INSTALL_DIR/sidecar/workspace"

# 5. doctor verification
run npm --prefix "$INSTALL_DIR/sidecar" run doctor
rc=$?
# `run` swallows rc in dry-run; in run mode npm exit code already killed script via set -e if nonzero.

echo
echo "== Next steps =="
echo "  cd $INSTALL_DIR/sidecar"
echo "  node src/index.ts --init-pairing --show-token   # pairing token (tampil sekali) + server start"
echo "  lalu buka app AnythingPocket di HP → Pocket → pairing manual (host + token)."
