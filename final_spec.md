# Spec: AnythingLLM Mobile Fork — "AnythingPocket"

**Status:** FINAL v1.1 — hasil panel review 3 agent (notulen: `review-panel-2026-10-25.md`). Nama resmi: AnythingPocket.
**Tanggal:** 25 Okt 2026
**Repo upstream:** https://github.com/Mintplex-Labs/anythingllm-mobile
**Lisensi upstream:** GPLv3 (release ≥1.2.0) — fork kita wajib GPLv3
**Bahasa:** Indonesia, gaya santai

---

## 1. Ringkasan / Elevator Pitch

Fork AnythingLLM Mobile yang mengubahnya dari "chatbot lokal pakai beberapa tool" menjadi **agent harness kelas Hermes yang bisa dibawa di saku**, dengan dua pilar:

1. **Sidecar server self-host** ("Harness Companion") — harness agent penuh jalan di komputer/VPS milik user, bukan infrastruktur kita. HP jadi remote control + trace viewer.
2. **Harness yang beneran** — file edit, MCP, skills, web scraping, approval gates, long-running jobs. Semua yang kurang di app aslinya.

**Filosofi:** local-first, no infrastructure dari kita, semua data tetap di mesin user. Zero recurring cost untuk project.

**Non-goal (eksplisit):** hosted relay/sync service milik kita, akun cloud, telemetry ke server kita.

---

## 2. Latar Belakang & Motivasi

### 2.1 Kondisi upstream

AnythingLLM Mobile (React Native + TypeScript + NativeWind, Android/iOS) sudah punya:

- On-device inference (GGUF via llama.rn) + konektor ke Ollama, LM Studio, LiteLLM, AnythingLLM instance, ~15 provider cloud, OpenAI-compatible apapun
- RAG on-device (embedding + vector db + reranking), web search agentic dasar, document generation, memory system
- Integrasi OS: default assistant, share/selection toolbar, background scheduled jobs

### 2.2 Gap yang ditemukan (dari pengalaman pakai langsung)

| Kemampuan | Upstream | Harness kelas Hermes |
|---|---|---|
| Edit/buat file | ❌ | Read/Write/Edit + diff |
| Web scraping mendalam | terbatas | Fetch + fallback + render JS |
| MCP | ❌ | Client penuh (tools/resources/prompts) |
| Skills | ❌ | Skill markdown yang load kontekstual |
| Loop & autonomy | single-shot | Multi-step, retry, self-correction |
| Transparansi | kotak hitam | Trace per step, intervensi mid-run |

### 2.3 Target pengguna

1. **Developer** — harness portabel, file ops, MCP, approval dari HP
2. **Profesional** — data tetap di mesin sendiri, audit trace, long-running jobs
3. **Pembelajar harness** — trace viewer membuat loop agent terlihat & bisa dipelajari

---

## 3. Arsitektur

```
┌─────────────────────────┐         ┌──────────────────────────────────┐
│  HP (fork AnythingLLM   │   WSS   │  VPS/Komputer user                │
│  Mobile)                │◄───────►│                                  │
│  - Thin client          │  token  │  Harness Companion (sidecar):    │
│  - Trace viewer         │  + TLS  │   - WS server + pairing          │
│  - Approval UI          │  pinned │   - Agent runtime (2 mode):      │
│  - Fallback on-device   │         │     • Lite  = AI SDK Core loop   │
│    SLM (offline chat)   │         │     • Full  = HarnessAgent + Pi  │
│  - Cache riwayat lokal  │         │   - Tools: file ops, web, MCP,   │
└─────────────────────────┘         │     skills, approval gates        │
                                    │   - Workspace dir + state store  │
                                    └──────────────────────────────────┘
```

### 3.1 Sidecar: Harness Companion

- Node/Bun + TypeScript, installer satu perintah (`curl ... | bash` dengan `--dry-run`/`--explain` + halaman "apa yang installer ini lakukan") + alternatif non-curl (`npx anythingpocket init` / Docker Compose)
- `anythingpocket doctor` — cek port, TLS, provider terdeteksi, output bahasa manusia
- Perf budget terukur (acceptance criteria M1): ukuran image & RAM puncak aktual, bukan angka tebakan
- Menyatu dengan model yang sudah ada di mesin user (Ollama, LM Studio, API provider, 9router, dll)
- Komponen:
  - **WS server** — transport ke HP, streaming trace, push notifikasi
  - **Agent runtime** — dua mode (lihat §4)
  - **Tool layer** — file ops, web, MCP, skills, shell
  - **State store** — SQLite: sessions, resume state, trace log, memory, skills index
  - **Pairing service** — QR/token, TLS self-signed + cert pinning

### 3.2 HP (fork client)

- Thin client: kirim prompt, render stream/trace, approval UI, notifikasi
- Tetap punya fallback on-device SLM untuk chat offline dasar (fitur upstream dipertahankan)
- Cache lokal riwayat + memory agar tetap terbaca saat server mati
- Semua fitur upstream yang tidak konflik dipertahankan (provider list, RAG on-device, export chat, dst)

### 3.3 Transport & koneksi (self-host permanen tanpa domain)

Tiga mode, dipilih otomatis oleh installer:

| Mode | Kondisi | Cara |
|---|---|---|
| **direct** | VPS dengan IP publik | WSS langsung ke IP, TLS self-signed + cert pinning. Tanpa domain, tanpa biaya. |
| **tailscale** | Komputer di belakang NAT | Installer pandu setup Tailscale di server + HP, connect via IP 100.x. Permanen, e2e encrypted. |
| **cloudflare** | User mau URL cantik | Cloudflare Tunnel + domain milik user (opsional, ~$10/th). |

Semua mode menghasilkan payload pairing yang identik (§5).

---

## 4. Agent Runtime — Dua Mode

### 4.1 Mode "Lite" — AI SDK Core

- `generateText`/`streamText` (AI SDK 5) + `stopWhen` multi-step loop + `experimental_createMCPClient`
- Provider apapun via AI SDK provider layer + adapter custom OpenAI-compatible
- Tools bawaan kita: file ops (sandboxed), web fetch/scrape, MCP bridge
- **Kekuatan:** ringan, model-agnostic total (termasuk model lokal kecil), support structured output
- Untuk: chat bertenaga tool, task pendek, model non-A anthropic/openai, user hemat

### 4.2 Mode "Full Harness" — AI SDK Harnesses + Pi

- `HarnessAgent` + `@ai-sdk/harness-pi` + runtime **Pi** (`@earendil-works/pi`, MIT, TypeScript)
- Pi berjalan **host-process** di mesin user (BUKAN sandbox Vercel — filosofi self-host dijaga)
- Dapat langsung: `read/write/edit/bash/grep/glob/ls`, MCP native (stdio + HTTP, deferred exposure), skills, tree sessions, compaction, session reattach, tool approval (`allow-reads`/`allow-edits`)
- Lifecycle callbacks (`onToolExecutionStart/End`, `onStepStart/End`, `onLanguageModelCallStart/End`) → sumber data trace viewer
- `providers` config + `auth` custom → model OpenAI-compatible apapun bisa dipakai
- **Batasan diketahui:** structured output tidak didukung (pakai Cepat/Lite untuk itu); API masih experimental (pin versi)
- **SPIKE GATE (sebelum M2):** spike 3–5 hari menjalankan Pi host-process + dump lifecycle callbacks ke JSONL. Go/no-go: apakah callback cukup buat trace viewer. Hasil spike juga menyelesaikan §11.2 (runtime final).
- **Abstraksi `HarnessRuntime`:** interface kontrak (tool schema, event stream, approval hook, session serialization) di depan runtime — exit criteria: kalau Pi breaking change >2x per kuartal, swap runtime harus <1 sprint.

### 4.3 Router / System One (pre-processor)

Sebelum task masuk ke agent, layer router menentukan mode & model. Filosofinya: **"router harus lebih transparan dari agent-nya"** — 5 prinsip:

1. **Deterministic-first** — keputusan routing harus bisa dijelaskan dalam satu kalimat ("ada request edit file → Full"). Kalau tidak bisa dijelaskan sependek itu, jangan otomatis — tanya user.
2. **Routing decisions masuk trace DAN badge chat UI** (`routed ke Lengkap karena: edit file`) — user awam tidak buka trace viewer.
3. **Explicit beats clever** — user bisa pin mode/model per chat, per workspace, atau per task. Router hanya mengisi kalau user tidak menentukan. Default user > default sistem.
4. **Fail toward capability, not cost** — kalau ambigu, pilih jalur yang bisa mengerjakan task (Full/server), bukan yang murah.
5. **Optional, bukan syarat** — bisa dimatikan total (mode Manual). Zero-magic untuk user yang mau kontrol penuh.

Alur keputusan (rule-based, tanpa LLM classifier di hot path):

```
Task masuk
   ├─ Ada schema/output eksplisit?      → Cepat (structured output)
   ├─ Butuh bash/file/MCP/tools berat?  → Lengkap (harness)
   ├─ Eskalasi mid-run: Cepat mendeteksi tool-miss → eskalasi ke Lengkap
   └─ Ambigu?                           → default Lengkap, TANPA LLM classifier
```

LLM classifier opsional (config), bukan wajib — tidak menambah latency/biaya diam-diam. Tier "chat murni" terpisah + eskalasi lanjutan: backlog.

**Penamaan user-facing (outcome, bukan stack):** Lite → **"Cepat"**, Full → **"Lengkap"**. Nama library (AI SDK, Pi) hanya muncul di trace/about, tidak di pemilihan mode.

### 4.4 Setup page: "Routing & Compute"

Muncul sebagai step opsional setelah pairing server (bisa di-skip):

1. **Mode routing:**
   - `Manual` (default) — user pilih mode/model per chat, zero magic
   - `Smart` — system one aktif; rule-based dulu; semua keputusan tercatat di trace
2. **Preferensi compute** (jika Smart): task ringan → on-device SLM / server (pilih); task berat → selalu server
3. **Fallback policy:** server mati → on-device fallback (default, dengan banner "mode offline") atau stop
4. Semua pilihan bisa diubah lagi di Settings; tiap chat bisa override. Tiap opsi ada one-line penjelasan konsekuensinya.

---

## 5. Pairing Protocol

### 5.1 Payload QR / manual entry (format sama)

```json
{
  "v": 1,
  "name": "Home Server",
  "host": "wss://203.0.113.42:7443",
  "mode": "direct",
  "token": "hbk_<256-bit random>",
  "cert_fp": "sha256:...",
  "expires": 1799000000
}
```

- `host`: mode tailscale → IP 100.x; mode cloudflare → domain user
- `token`: pairing token, kedaluwarsa default 7 hari; setelah connect pertama, server issue token sesi jangka panjang dan QR mati
- `cert_fp`: fingerprint cert self-signed → app pin; TOFU untuk manual entry
- Manual entry: cukup 2 field (endpoint + token), `cert_fp` & `name` ditarik otomatis saat handshake pertama

### 5.2 Handshake

1. HP connect WSS + kirim `token`
2. Server validasi → issue device ID + session token (disimpan di HP secure storage)
3. Semua message berikutnya pakai session token; TLS pinned ke `cert_fp`

### 5.3 Reconnect

- HP offline/beda jaringan → auto-reconnect dengan exponential backoff
- Server restart → resume session dari state tersimpan (sidecar), riwayat chat di-cache HP

---

## 6. Keamanan

- **TLS self-signed + cert pinning** — manual entry TIDAK auto-pull fingerprint: wajib verifikasi kedua-kali-tampil (bandingkan SHA256 di HP vs layar server). Klaim "MITM mustahil" dihapus; TOFU QR tetap terlindungi `cert_fp` bawaan.
- **Hardening endpoint:** sidecar hanya expose `/ws` (auth token); rate-limit + lockout 5 handshake gagal per IP (fail2ban-style).
- **Token per-device** — revoke per device dari Fleet view
- **Sandbox bash NYATA (syarat rilis, bukan nice-to-have):** container (Docker user namespace) atau landlock/bubblewrap, dengan **egress allowlist** (hanya model provider/proxy). Low-privilege user SAJA tidak cukup (env vars & egress tetap bocor).
- **Secrets via proxy:** API keys TIDAK di-inject ke agent process — dipakai lewat proxy server-side; agent tak pernah melihat key.
- **Approval gate anti blind-click:** tampilkan diff penuh + hash command; allowlist per-workspace yang bisa diaudit dari HP.
- **Approval pending punya TTL hard; default REJECT** (bukan approve) kalau HP offline — tercatat di trace.
- **State model:** server = source of truth untuk sessions; HP cache read-only + invalidasi by session-rev. State machine reconnect di-spec-kan sebelum M1 rilis (bukan cuma backoff).
- **State at rest:** SQLite permission 0600 + user khusus (SQLCipher dievaluasi di M3).
- **Tidak ada data ke pihak ketiga** — kecuali model provider yang dipilih user sendiri. Notifikasi: WebSocket foreground + WebPush VAPID self-hostable / ntfy; FCM/APNs hanya opsional (payload disanitasi, kontradiksi filosofinya didokumentasikan).

---

## 7. Fitur Utama (nilai jual fork)

1. **Trace viewer 3 tingkat** (progressive disclosure): ① **Rangkuman** default ("Step 4/9 — baca file X → edit Y (2.1s)"), ② **Detail per step** (tap → args & hasil), ③ **Raw/"mode belajar"** (full JSON/reasoning, toggle di settings). Bisa export/share satu file. Schema trace = event schema kita sendiri yang menormalisasi Lite & Full (jawaban §11.3).
2. **MCP client** — config `mcp.json` di server, tools muncul di HP, per-server. Pakai SDK stabil.
3. **Skills** — folder skills di server (format agentskills.io)
4. **Web tooling** — fetch + scrape + render opsional, terpisah dari web search, dengan sitasi
5. **Approval gates** — human-in-the-loop dari HP, termasuk interrupt mid-run
6. **Fleet view** — beberapa server, pilih per chat (backlog, post-M3)
7. **Background jobs** — long-running turn di server, notifikasi WebPush/ntfy (backlog M3)
8. **Hybrid model routing** — ringan → on-device; berat/butuh tools → server (M3)
9. **UX de-jargonisasi** — label koneksi satu status ("✅ Tersambung — aman, terenkripsi"; detail mode di collapsible "Detail teknis"); alur re-pairing 1 layar dengan pesan jelas; copy one-line penjelasan (bilingual EN+ID) ditulis SEBELUM coding UI

---

## 8. Stack & Dependency

| Layer | Teknologi |
|---|---|
| HP client | React Native (fork upstream), TypeScript, NativeWind |
| Sidecar | Node.js/Bun + TypeScript |
| Agent core (Lite) | AI SDK 5 (`ai`) + provider adapters |
| Agent harness (Full) | `@ai-sdk/harness` + `@ai-sdk/harness-pi` (menarik `@earendil-works/pi-coding-agent` otomatis — perhatian: `@earendil-works/pi` TANPA suffix TIDAK ADA di npm) |
| Sandbox local | `@ai-sdk/sandbox-just-bash` (host-process) |
| MCP | `experimental_createMCPClient` (Lite) + MCP native Pi (Full) |
| State | SQLite (sidecar), RN storage (HP) |
| Transport | WebSocket (ws), TLS self-signed, cert pinning |
| Notifikasi | FCM (Android) / APNs (iOS) |

Catatan: pin semua versi experimental; upgrade manual terkontrol.

---

## 9. Roadmap (v1.1 — restrukturisasi hasil panel)

Prinsip: tiap task delegasi wajib **leave-behind artifact** (script + test + docs 1 paragraf) biar resumable. Spike iOS ATS (self-signed cert di NSAppTransportSecurity) minggu pertama M1 — kalau gagal, semua mode direct di-rethink.

### M0 — Spike (1 minggu)
- [ ] **Spike Pi:** Node standalone, Pi host-process, dump lifecycle callbacks ke JSONL → go/no-go (gate M2 + jawab §11.2)
- [ ] **Spike iOS ATS:** WSS self-signed dari RN di iOS → go/no-go mode direct

### M1 — Fondasi (3–4 minggu)
- [ ] Fork repo, build Android
- [ ] Sidecar core: WS server + token auth + SQLite (testable via `wscat`, tanpa HP)
- [ ] Mode Lite end-to-end via CLI (`anythingpocket run`) — prompt masuk, tool call, trace ke SQLite
- [ ] HP: chat screen → WSS (Tailscale-first: TLS handled Tailscale, tanpa pinning code dulu), pairing manual entry + QR
- [ ] Installer + `doctor`
- [ ] Perf budget terukur (image size, RAM aktual)

### M2a — Harness Minimum Demo-able (3–4 minggu)
- [ ] Mode Full (Pi di balik abstraksi `HarnessRuntime`)
- [ ] Approval gates + interrupt mid-run (TTL + default reject)
- [ ] Trace viewer basic (tingkat Rangkuman) — file ops + web fetch
- [ ] Sandbox bash (container/landlock) + secrets proxy

### M2b — Ekosistem (3–4 minggu)
- [ ] MCP (stable SDK `@modelcontextprotocol/sdk`; config file di server dulu, UI belakangan)
- [ ] Skills (read-only dulu)
- [ ] Trace viewer tingkat Detail + Raw/"mode belajar" + export

### M3 — Matang (3–4 minggu)
- [ ] Mode direct (TLS self-signed + cert pinning) & Cloudflare mode
- [ ] Hybrid routing + Setup page "Routing & Compute" (§4.4)
- [ ] Background jobs + WebPush VAPID/ntfy (FCM opsional)
- [ ] SQLCipher evaluasi, hardening, audit keamanan, docs

### Backlog (post-M3)
- Fleet view multi-server, memory sync dua arah, usage/cost dashboard, tier chat murni + eskalasi lanjutan

---

## 10. Risiko Terbuka

| Risiko | Mitigasi |
|---|---|
| API harness AI SDK experimental, breaking changes | Pin versi, abstract layer sendiri di atasnya |
| bash tidak ter-sandbox oleh fileToolPathPolicy | User OS low-privilege + approval gate |
| Pi gak support structured output | Pakai mode Lite untuk kasus itu |
| Onboarding berat buat user awam | Installer robust + docs; target jelas: developer/profesional/pembelajar |
| Sinkronisasi state HP↔server kompleks | SQLite server-side + cache HP; conflict resolution last-write-wins per field |

---

## 11. Keputusan Terbuka (perlu meeting lanjutan)

1. ~~Nama project~~ → **diputuskan:** "AnythingPocket" (mempertahankan identitas AnythingLLM sebagai fork)
2. ~~Pi vs Cline vs fx~~ → **diselesaikan lewat Spike Pi di M0** (go/no-go gate)
3. ~~Format trace~~ → **diputuskan:** event schema kita sendiri, menormalisasi Lite & Full ke satu bentuk
4. Bahasa UI: **bilingual tiered** (UI inti EN+ID; copy penjelasan ditulis sebelum coding UI)
5. Kapan mulai eksekusi M0 dan siapa yang ngerjain (orchestrator + sub-agent delegasi, tiap task leave-behind artifact)
