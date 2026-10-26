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
  --direct) MODE="direct" ;;
  --cloudflare) MODE="cloudflare" ;;
  *) echo "Usage: bash install.sh [--dry-run | --explain | --direct | --cloudflare]"; exit 2 ;;
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

if [ "$MODE" = "direct" ]; then
  # Spec §3.3 direct mode: WSS ke IP publik, TLS self-signed + cert pinning.
  cat <<EOF
== Mode DIRECT (WSS ke IP publik, TLS self-signed + cert pinning) ==

PERINGATAN / WARNING: langkah ini membuka port 7443 ke internet publik.
Hanya lanjutkan kalau kamu paham konsekuensinya: mesin ini akan bisa dijangkau
siapa pun dari internet di port itu (perlindungan: TLS self-signed + token auth
+ lockout 5x gagal, tapi port tetap terekspos). Alternatif lebih aman: mode
Tailscale (tidak perlu port publik).

Langkah:
  1. Buka firewall HANYA port 7443/tcp (contoh ufw):
       sudo ufw allow 7443/tcp
     (di VPS provider, buka juga security group / firewall cloud untuk 7443/tcp.)
  2. Generate cert self-signed + start server:
       cd $INSTALL_DIR/sidecar
       POCKET_TLS=on node src/index.ts --init-pairing --show-token
     - cert disimpan di sidecar/data/{cert,key}.pem (0600), masa berlaku 10 tahun.
     - SAN default: loopback + IP utama mesin. IP/domain lain:
       POCKET_SAN="IP:203.0.113.42,DNS:home.example" (env, sebelum perintah).
  3. Pairing payload tercetak (spec §5.1) berisi "cert_fp". VERIFIKASI
     KEDUA-KALI-TAMPIL: pastikan cert_fp yang tampil di HP sama persis dengan
     yang tampil di layar server ini (proteksi MITM, spec §6).
  4. HP connect ke wss://<IP-server>:7443/ws pakai token di payload.
EOF
elif [ "$MODE" = "cloudflare" ]; then
  cat <<'EOF'
== Mode CLOUDFLARE (Cloudflare Tunnel + domain milik kamu) ==

Installer ini TIDAK meng-install cloudflared — kamu yang pasang dari sumber
resmi: https://developers.cloudflare.com/cloudflare/one-page/#download-and-install
(Cek terpasang: command -v cloudflared)

Langkah:
  1. Pasang cloudflared + login:  cloudflared tunnel login
  2. Buat tunnel + route ke domain kamu:
       cloudflared tunnel create anythingpocket
       cloudflared tunnel route dns anythingpocket pocket.domainkamu.com
  3. Tambahkan ke config cloudflared:
       ingress: - hostname: pocket.domainkamu.com
                  service: http://localhost:7443
  4. Jalankan sidecar (plain ws, TLS ditangani Cloudflare):
       cd $INSTALL_DIR/sidecar && node src/index.ts --init-pairing --show-token
  5. Start tunnel: cloudflared tunnel run anythingpocket
  6. Pairing di HP: host "pocket.domainkamu.com" (wss:// otomatis via Cloudflare).
EOF
else
  cat <<'EOF'
  cd $INSTALL_DIR/sidecar
  node src/index.ts --init-pairing --show-token   # pairing token (tampil sekali) + server start
  lalu buka app AnythingPocket di HP → Pocket → pairing manual (host + token).
  Mode transport: default bind 127.0.0.1 (tailscale) — untuk WSS ke IP publik
  jalankan ulang installer dengan --direct, atau --cloudflare untuk tunnel.
EOF
fi
