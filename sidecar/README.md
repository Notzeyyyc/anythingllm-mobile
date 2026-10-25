# AnythingPocket Sidecar — "Harness Companion" (M1 core)

Sidecar = agent harness penuh yang jalan di komputer/VPS user. HP cuma remote
control + trace viewer. Paket ini adalah fondasi M1: **WS server + token auth +
SQLite state store**, testable penuh via `wscat`/Node WS client **tanpa HP**
(roadmap §9 M1).

## Run

```bash
cd sidecar
npm install

# health check (node version, data dir writable, port free)
npm run doctor                     # alias: node src/index.ts --doctor

# start server + cetak pairing token (TER-REDAKSI: hbk_4e... saja)
npm start                          # atau: node src/index.ts
node src/index.ts --init-pairing   # pairing token (redacted) + server start
node src/index.ts --init-pairing --show-token   # token PENUH sekali di layar
```

Env: `PORT` (default 7443), `BIND` (default `127.0.0.1` — jangan dibuka ke luar
tanpa TLS; mode direct WSS itu M3).

## Test

```bash
npm test
```

19 assert, plain asserts tanpa framework, exit 0 = hijau. Mencakup: connect
tanpa token ditolak, token ngaraco ditolak, pairing token valid → session token
(`hbs_...`), pairing single-use, reconnect pakai session token tanpa re-pair,
approval TTL 2s tanpa jawaban → auto REJECT (`expired`) tercatat di trace,
revoke device → session token mati, 5x handshake gagal per IP → lockout
(fail2ban-style), dan scan DB bahwa tidak ada token mentah (`hbk_`/`hbs_` full
hex) yang tersimpan — cuma SHA-256 hash.

## Arsitektur singkat

```
HP/wscat ──ws://127.0.0.1:7443/ws──► ws.ts ──► auth.ts (pairing/session token)
                                             └► db.ts (node:sqlite: WAL)
   schema.ts: satu trace event schema (§7.1) — dipakai Lite & Full nanti
```

- **`src/schema.ts`** — event schema tunggal (spec §7.1): 12 event type
  (`session.start`, `turn.start`, `llm.call.*`, `tool.call.*`,
  `approval.*`, `turn.end`, `error`), field `id/ts/sessionId/turnId/type/payload/rev`.
  Ada payload whitelist per event type + regex block untuk key mirip-secret
  (`token|secret|password|apikey|...`) — secret tidak bisa masuk trace walau
  producer salah kirim.
- **`src/db.ts`** — `node:sqlite` (stdlib, Node ≥22.5, tanpa native dep): tabel
  `devices` (token disimpan sebagai hash SHA-256, revoke per device), `sessions`,
  `events` (append-only trace log, `rev` monotonik per session), `approvals`
  (status `pending` → `granted/rejected/expired`, resolve idempotent).
- **`src/auth.ts`** — pairing token `hbk_<64 hex>` (256-bit, TTL default 7 hari,
  single-use), session token `hbs_<64 hex>` per device (TTL 1 tahun; revoke =
  kill switch sebenarnya), lockout 5 handshake gagal per IP selama 10 menit
  (in-memory, fail2ban-style), `redact()` untuk semua logging token
  (6 char pertama + `...`).
- **`src/ws.ts`** — WS server path `/ws`: pesan pertama wajib `{"type":"auth",
  "token":"..."}` (timeout 5s); trace event dikirim langsung sebagai type-nya
  sendiri (mis. `{"type":"tool.call.start","turnId":"...","payload":{...}}`);
  approval sweep tiap 250ms menegakkan TTL hard → default REJECT; ping/pong
  keepalive.
- **`src/doctor.ts`** — `anythingpocket doctor`: node version, DB writable,
  port free; output bilingual EN+ID, exit 0 = sehat.
- **`src/index.ts`** — entrypoint + `--init-pairing` / `--doctor`.

## Cara coba via wscat (tanpa HP)

```bash
# terminal 1
cd sidecar && npm start
# terminal 2 (terminal lain):
wscat -c ws://127.0.0.1:7443/ws
# tanpa auth: kirim apa pun → kena close 4003 "first message must be auth"
> {"type":"auth","token":"PASTE_PAIRING_TOKEN"}          # → auth.ok + sessionToken (sekali)
> {"type":"session.start"}                               # → session.started + sessionId
> {"type":"tool.call.start","turnId":"t1","payload":{"tool":"bash","argsHash":"abc"}}
                                                         # → event.accepted (rev naik)
> {"type":"approval.create","turnId":"t1","payload":{"tool":"bash","command":"ls","ttlMs":5000}}
                                                         # → approval.pending; diamkan 5s → approval.expired
# reconnect (server restart / ganti jaringan): auth langsung pakai sessionToken
> {"type":"auth","token":"PASTE_SESSION_TOKEN_hbs_..."}
```

Tanpa wscat: `npm test` sudah mewakili alur yang sama via Node native WebSocket.

## Keputusan & dependency baru

- **`ws` ^8.22.0 (runtime dep)** — Node native WebSocket cuma client, tidak ada
  server API; server WS butuh `ws`. Ini stack resmi spec §8 ("Transport:
  WebSocket (ws)").
- **devDependencies: `typescript`, `@types/ws`, `tsx`** — TS strict (`npm run
  typecheck`) dan runner dev alternatif; runtime jalan polos
  `node --experimental-strip-types` tanpa build step.
- **`zod` TIDAK dipakai** — validator manual (whitelist + regex secret-guard)
  lebih pendek dan cukup untuk satu schema internal. Tambahkan zod kalau
  schema dipakai lintas package / producer pihak ketiga.
- **Pairing token in-memory** (bukan tabel DB) — restart server = pairing token
  mati; cukup untuk M1, upgrade path: tabel `pairings` di db.ts saat butuh
  persist (M2). Session token & device TETAP persisten di SQLite.
- **Lockout in-memory** per IP, reset saat restart — M1, sesuai spec §6
  ("fail2ban-style"); upgrade path: tabel DB + shared store kalau multi-process.
- **TLS belum ada** — default bind `127.0.0.1`; WSS + cert pinning itu M3
  (spec §6/§9). Jangan set `BIND=0.0.0.0` tanpa TLS di depannya (Tailscale /
  reverse proxy).
- **Approval status `expired` ≠ `rejected`** di DB tapi keduanya default-REJECT
  secara semantik (agent harus memperlakukan keduanya sebagai "jangan jalankan");
  trace mencatat `approval.expired` agar bisa dibedakan di trace viewer.
