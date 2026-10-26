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

Test total (M2a): 19 + 14 + 20 + 32 = 85 assert hijau (`npm test`). Suite e2e
(19 assert) mencakup: connect
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

## Mode Lite (AI SDK 5, M1)

CLI `npm run lite -- "prompt"` (alias `anythingpocket run "prompt"`) menjalankan
agent Cepat: `streamText` + `stopWhen` multi-step dengan 3 tool sandboxed ke
workspace (`read_file`, `list_dir`, `write_file`; path di luar workspace dan
`../` escape ditolak, baca dibatasi 2MB). `write_file` = tool berbahaya: tanpa
`--yes` CLI menampilkan diff dan bertanya `[y/N]` dari stdin dengan TTL hard
30 detik → default REJECT (spec §6); semua keputusan approval tercatat sebagai
event trace (`approval.requested/granted/rejected`) ke SQLite pakai schema
tunggal di `src/schema.ts`. Env: `POCKET_MODEL` (default
`ngd/ngodeai/gemini-3.8-flash`), `POCKET_BASE_URL` (default
`http://127.0.0.1:20128/v1`), `POCKET_API_KEY_FILE` (default
`/root/.secrets/9router_local_key.txt`, dibaca saat runtime — tidak pernah
masuk log/trace), `POCKET_WORKSPACE` (default `sidecar/workspace/`),
`POCKET_DATA_DIR` (default `sidecar/data/`). Flag `--model/--base-url/--api-key-file`
meng-override env. Test: `npm run test:lite` (mock model via `ai/test`,
19+14 assert). Batasan M1: approval masih interaktif via CLI stdin; push
approval ke HP lewat WS adalah kelanjutan M1 (infra WS/approval di
`ws.ts`/`db.ts` sudah ada). Retry network provider max 2×.

## Keputusan & dependency baru

- **`ws` ^8.22.0 (runtime dep)** — Node native WebSocket cuma client, tidak ada
  server API; server WS butuh `ws`. Ini stack resmi spec §8 ("Transport:
  WebSocket (ws)").
- **devDependencies: `typescript`, `@types/ws`, `tsx`** — TS strict (`npm run
  typecheck`) dan runner dev alternatif; runtime jalan polos
  `node --experimental-strip-types` tanpa build step.
- **`zod` ^4 (runtime dep, BARU)** — peer dependency wajib AI SDK 5 untuk
  `inputSchema` tool Mode Lite; dipakai hanya di `src/lite/tools.ts`. Sebelumnya
  README bilang zod TIDAK dipakai — itu masih berlaku untuk validator trace
  (manual whitelist + secret-guard tetap dipertahankan); zod kini cuma untuk
  skema input tool AI SDK.
- **`ai` @5.0.281 + `@ai-sdk/openai-compatible` @1.0.59 (runtime dep)** — stack
  resmi spec §8 untuk Mode Cepat/Lite; di-pin versi (spec §8: experimental
  harus di-pin).
- **Mode Full / M2a (`@ai-sdk/harness@1.0.164`, `@ai-sdk/harness-pi@1.0.167`,
  `@ai-sdk/sandbox-just-bash@1.0.164`, `just-bash@2.14.5` — semua di-pin exact)**
  — Pi host-process di balik `HarnessRuntime` (spec §4.2); detail, keterbatasan,
  dan status sandbox partial: `docs/m2a-full-runtime.md`. Router deterministik
  di `src/router.ts`, secrets proxy di `src/secrets-proxy.ts`, smoke real:
  `node --experimental-strip-types scripts/smoke-full.ts`.
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
## Protokol WS v1 — agent runtime (`runtime.ts`)

Setelah `session.start`, satu device punya SATU agent loop aktif. `turn.request`
menjalankan Mode Lite async (tidak memblok event loop WS): teks parsial
di-stream sebagai `turn.delta`, trace event tetap masuk DB + di-push, dan tool
`write_file` memicu `approval.request` ke HP dengan TTL hard server-side —
tanpa `approval.response` sampai TTL habis, approval otomatis REJECT
(`approval.expired` di DB/trace). `approval.response` idempotent; id asing/terlambat
diabaikan. Kontrak pesan:

| Arah | `type` | Isi utama |
|---|---|---|
| C→S | `auth` | `token` (`hbk_`/`hbs_`) |
| C→S | `session.start` | — |
| C→S | `turn.request` | `turnId` (client uuid), `prompt` |
| C→S | `turn.interrupt` (v1.1, additive) | `turnId` → server balas `turn.interrupt.ack {interrupted}`; turn aktif di-abort → `turn.end ok:false error:"interrupted"` |
| C→S | `approval.response` | `approvalId`, `decision: "grant"\|"reject"` |
| S→C | `auth.ok` / `auth.deny` | `deviceId` (+`sessionToken` saat pairing) |
| S→C | `session.started` | `sessionId` |
| S→C | `turn.delta` | `turnId`, `delta` (teks parsial) |
| S→C | `turn.end` | `turnId`, `ok`, `text`, `error` |
| S→C | `approval.request` | `approvalId`, `turnId`, `tool`, `path`, `contentPreview`, `ttlMs` |
| S→C | trace events | `turn.start`, `llm.call.*`, `tool.call.*`, `approval.*` (payload sesuai schema) |
| S→C | `error` | `message` (termasuk `turn in progress`) |

Test manual via wscat: `npm start` lalu di wscat `ws://127.0.0.1:7443/ws`,
kirim `{"type":"auth","token":"<hbk_...>"}` (token dari
`npm start -- --init-pairing --show-token`), `{"type":"session.start"}`, lalu
`{"type":"turn.request","turnId":"t1","prompt":"tulis file catatan.txt"}` — balas
approval dengan `{"type":"approval.response","approvalId":"<id>","decision":"grant"}`.

## Sandbox bash (syarat rilis, spec §6)

Bash tool mode Full berjalan di **bubblewrap (bwrap)** — kebutuhan HOST, install
via `apt install bubblewrap` (bukan dependency npm). Container: `--unshare-net`
(tanpa network sama sekali → egress allowlist dipenuhi by construction),
`--unshare-pid --die-with-parent --new-session`, root read-only + workspace
re-bind RW, `/etc/passwd`+`/etc/shadow` dimasking, `--clearenv`. Satu-satunya
jalan keluar adalah **secrets-proxy UNIX socket** (`startSecretsProxy` dengan
`socketPath`) yang di-bind-mount read-only ke dalam sandbox — akses model hanya
via proxy itu (dari dalam sandbox: `curl --unix-socket <path> <proxy-url>`).
Konfigurasi via env `POCKET_SANDBOX=auto|bwrap|docker|required|none` (default
`auto`): mekanisme tidak tersedia + `required` → error jelas, turn gagal;
`auto`/`none` tanpa mekanisme → **tool bash DIMATIKAN** + warning tercatat di
trace (`sandbox.decided`) — fail toward safety. Pi builtin write/edit/bash
berjalan `permissionMode: 'allow-reads'` → approval via hook yang sama dengan
Lite (WS `approval.request`/`approval.response`). Uji: `test/sandbox.test.ts`
(escape path, network deny, proxy socket 200, fallback policy).
