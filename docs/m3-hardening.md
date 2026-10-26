# M3 Hardening Audit + SQLCipher Evaluation

Tanggal: 26 Okt 2026. Scope: `sidecar/` (M3 task, spec §6, §9 M3).
Metode: baca ulang `auth.ts`/`db.ts`/`ws.ts`/`sandbox.ts`/`notify.ts` + test
existing (e2e lockout, token-scan, TTL default-REJECT).

## SQLCipher evaluation (keputusan)

**Keputusan: DEFER — ganti enkripsi at-rest kolom dengan AES-256-GCM via
node:crypto untuk payload sensitif. Tidak pakai SQLCipher.**

Alasan:

1. **node:sqlite (stdlib) tidak support SQLCipher.** Pergi ke SQLCipher berarti
   menambah dep native (`better-sqlite3` + build SQLCipher, atau `@journeyapps/sqlcipher`)
   — melanggar aturan repo "stdlib dulu" (AGENTS.md §5), menambah build native
   yang harus dicompile per-platform, dan menggantikan lapisan DB yang sudah
   hijau 85+ assert.
2. **Ancaman yang relevan** adalah file DB terbaca oleh proses/backup lain di
   mesin yang sama. Kolom yang benar-benar sensitif di DB:
   - `session_history.content` (prompt user + hasil agent) — **sensitif, kini
     dienkripsi at-rest** (lihat di bawah).
   - `devices.token_hash` — sudah SHA-256 hash (tidak reversible) ✔
   - `approvals.command/diff` — preview tool call; bisa berisi snippet file.
     Sensitif-sedang. Backlog (lihat bawah).
   - `events.payload` — sudah melewati whitelist + regex block secret-like key
     (schema.ts) sebelum masuk DB ✔.
3. **SQLCipher mengenkripsi seluruh DB tapi kuncinya harus disimpan di suatu
   tempat** — tanpa HSM/KMS, key ikut di mesin yang sama. Gain marginal dibanding
   kolom-tertentu untuk data yang sama, dengan biaya native dep besar.

 ponytail: kalau someday ada kebutuhan "DB penuh tak-baca", upgrade path-nya
 `better-sqlite3` + SQLCipher build — API-nya drop-in dibanding node:sqlite,
 jadi defer ini murah.

## Yang diimplementasi (M3)

- **Enkripsi at-rest `session_history.content`** — kolom sensitif utama
  (prompt & jawaban agent). Key 256-bit di-generate sekali, disimpan di
  `sidecar/data/history.key` (mode 0600, di luar DB — DB dan key tidak jadi
  satu file yang sama). AES-256-GCM per-record (IV acak per record, auth tag
  disertakan); `appendHistory` menulis ciphertext, `listHistory` mendekripsi.
  Gagal dekripsi (key hilang/rotasi) → record dilewati dengan warning, tidak crash.
- **Cert/key TLS 0600** di `data/{cert,key}.pem`, cert self-signed masa 10 tahun
  (`src/tls.ts`).

## Audit checklist (spec §6)

| Item | Status | Catatan |
|---|---|---|
| Rate-limit lockout 5x/IP | ✔ ada (`auth.ts`, diuji e2e) | in-memory — restart menghapus; backlog: persist ke DB |
| TTL approval + default REJECT | ✔ ada (hard TTL, sweep 250ms, status `expired`) | diuji e2e + runtime |
| Token expiry | ✔ pairing 7 hari, session 1 tahun; expired ditolak | |
| Token tak pernah mentah di log/DB | ✔ hanya SHA-256 hash; scan test e2e | `redact()` semua logging |
| Secrets di log — scan manual | ✔ bersih | `notify.ts` payload fixed-title+sessionId; secrets proxy tidak log key |
| Sandbox bash + egress | ✔ bwrap `--unshare-net` (egress via secrets-proxy socket saja); tanpa sandbox → bash disabled | sandbox.test.ts |
| Port bind default | ✔ 127.0.0.1 default; TLS direct mode bind 0.0.0.0 hanya eksplisit via `--direct` | install.sh memperingatkan port publik |
| Push payload sanitasi | ✔ baru (M3): hanya title fixed + sessionId, tanpa konten | m3.test.ts assert |
| Push endpoint auth | ✔ `push.subscribe` hanya setelah auth WS token | |
| Secrets proxy | ✔ API key tidak pernah ke agent process | M2a |
| Cert pinning TOFU | ✔ baru (M3): cert_fp tampil di pairing payload + verifikasi kedua-kali-tampil; client default menolak self-signed CA (test) | |

## Ditemukan kurang → backlog terdokumentasi (tidak murah / bukan M3)

1. **Lockout in-memory** — restart menghapus counter. Persist per-IP ke tabel DB
   (murah, tapi sentuh auth hot path → M4/hardening lanjutan).
2. **`approvals.command/diff` plaintext di DB** — enkripsi sama seperti history
   kalau tool-call preview dianggap sensitif. Effort kecil, perlu keputusan
   apakah trace viewer butuh baca plaintext (iya, dari HP) → butuh key di
   server-side decode path; doable, ditunda sampai ada permintaan.
3. **DB file permission** — `data/sidecar.db` mengikuti umask proses. Installer
   sudah bikin dir; tambahkan `chmod 600` eksplisit + user khusus systemd unit
   → backlog (spec §6 "user khusus").
4. **Pairing token in-memory** (ponytail lama, auth.ts) — restart mematikan
   pairing belum-dipakai. Persist ke DB ketika fleet >1 device jadi nyata.
5. **ntfy/WebPush tanpa retry** — fire-and-forget; kalau delivery notif jadi
   SLA, tambah queue.
6. **iOS ATS spike: BLOCKED** — tidak ada Mac untuk build iOS. Mode direct di
   Android terverifikasi via test WSS; sisi iOS (NSAppTransportSecurity +
   self-signed cert) menunggu akses perangkat/build. Jangan claim mode direct
   berfungsi di iOS sebelum spike ini jalan.
