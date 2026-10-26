# AnythingPocket — Perf Budget (TERUKUR / measured)

Tanggal / date: **26 Okt 2026**. Semua angka di bawah diukur aktual di box ini,
bukan estimasi. Milestone: M1 "Perf budget terukur" (spec §9).

## Kondisi pengukuran / measurement conditions

- VPS 8 GB RAM (7.9 GB total), 4+ vCPU, disk 155 GB (dua-duanya longgar saat ujian).
- OS Linux 5.15, Node **v25.9.0** (`node --experimental-strip-types`, tanpa tsx di
  jalur runtime).
- Sidecar di-copy ke `/tmp/perfcar/repo/sidecar` (dev dir tidak disentuh), deps
  production saja: `npm ci --omit=dev`.
- Model ujian: 9router lokal `ngd/ngodeai/gemini-3.8-flash` di
  `http://127.0.0.1:20128/v1` (1 turn agent nyata via WS: auth → session.start →
  turn.request; tool call + approval auto-reject; turn selesai normal ±22.6 dtk).

## Angka aktual / measured numbers

| Metrik | Nilai | Cara ukur |
|---|---|---|
| Sidecar `node_modules` (prod only) | **19 MB** | `du -sh node_modules` setelah `npm ci --omit=dev` |
| Footprint install penuh `~/.anythingpocket` | **114 MB** | install.sh end-to-end di `HOME=/tmp/fakehome`, lalu `du -sh` (termasuk clone `.git` ~95 MB) |
| Startup time (spawn → port listening) | **434 ms / 387 ms** (2 run) | probe TCP ke port dari proses child segera setelah `spawn`; polling 10 ms |
| Idle RSS | **~96 MB** (VmRSS 95,916 kB) | `/proc/<pid>/status VmRSS` saat server hidup, belum ada turn |
| Peak RSS setelah 1 turn agent (real model) | **~117 MB** (VmHWM 119,908 kB) | `/proc/<pid>/status VmHWM` setelah `turn.end` |
| RSS setelah turn (settled) | ~96 MB (96,116 kB) | VmRSS setelah `turn.end` |
| APK release (image size, spec "ukuran image") | **53,771,309 bytes ≈ 51.3 MB** | `ls -la android/app/build/outputs/apk/release/app-release.apk` (build 25 Okt 2026) |

## Budget & kapan khawatir / budget & when to worry

**Budget: idle RSS < 150 MB, peak < 300 MB, startup < 5 dtk.**

Aktual hari ini: idle 96 MB (64% budget), peak 117 MB (39% budget), startup
0.4 dtk (8% budget). Semua jauh di bawah budget — headroom cukup untuk M2
(Mode Full / Pi host-process akan menambah proses child, jadi peak ini hanya
angka sidecar induk).

Khawatir / investigate jika:

- Idle RSS > 150 MB tanpa beban → kemungkinan leak; bandingkan dengan angka
  baseline di atas sebelum menyalahkan fitur baru.
- Peak > 300 MB pada 1 turn tunggal → tool loop atau provider layer bocor
  buffer; profil sebelum merge fitur M2a.
- Startup > 5 dtk → jangan terima; installer/doctor harus tetap instan.
- APK > 80 MB → periksa dependency native baru / asset yang ikut ter-bundle.

## Catatan metode / method notes

- RSS/VmHWM dibaca dari `/proc/<pid>/status` — VmHWM = high-water mark sejak
  proses start, jadi angka peak mencakup seluruh umur proses (termasuk turn).
- Startup diukur dua kali pada proses berbeda; variasi ±50 ms normal.
- Turn ujian memakai model streaming via 9router lokal; angka ini mencakup
  streamText multi-step + 1 tool call (read-only) + approval auto-reject TTL.
- Footprint `~/.anythingpocket` didominasi `.git` (~95 MB); working copy
  sidecar + deps hanya ~19 MB. Kalau mau lebih ramping, installer bisa
  `git clone --depth 1` (ponytail: full clone dipilih supaya user bisa update
  & git blame; ganti ke `--depth 1` kalau footprint jadi masalah).
- Angka produksi user bisa beda (RAM lebih kecil, arsitektur lain) — angka di
  atas adalah baseline dev box ini.
