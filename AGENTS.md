# AGENTS.md — AnythingPocket

> Aturan kerja untuk AI Agent (dan manusia) yang mengerjakan repo AnythingPocket.
> Referensi desain: `final_spec.md` (spec v1.1 hasil panel review 25 Okt 2026).

## 1. Identitas Proyek

- **Nama:** AnythingPocket — fork AnythingLLM Mobile (GPLv3, identitas upstream dipertahankan).
- **Konsep:** HP = thin client + trace viewer; server user (sidecar "Harness Companion") = agent harness penuh.
- **Filosofi (JANGAN dilanggar):** local-first, zero infra dari kita, transparan (semua keputusan tercatat), user kontrol penuh (explicit beats clever), fail toward capability.

## 2. Instruksi Utama

1. **Baca `final_spec.md` sebelum mengerjakan apa pun.** Jangan asumsikan desain; spec adalah sumber kebenaran.
2. **Ikuti roadmap & milestone di spec (§9).** Jangan mengerjakan item backlog (Fleet view, memory sync dua arah, tier chat murni) kecuali diminta eksplisit.
3. **Spike dulu sebelum commit arsitektur.** M0 (spike Pi + spike iOS ATS) adalah go/no-go gate. Jangan mulai M2 sebelum spike selesai dan keputusannya tercatat.
4. **Setiap task wajib leave-behind artifact**: script/fitur + test + docs 1 paragraf. Kerja harus resumable — asumsikan sesi kamu bisa mati kapan saja, tulis file secara incremental.
5. **Working directory:** semua perubahan di repo ini. Jangan sentuh sistem di luar repo (kecuali install dependency yang di-declare di package.json).

## 3. Larangan (HARD RULES)

1. **JANGAN pernah menyimpan/mengirim secrets** (API key, token, password) ke log, trace, chat, atau file di repo. Secrets dipakai via proxy server-side — agent process TIDAK pernah melihat API key (spec §6).
2. **JANGAN menonaktifkan/menembus security boundary**: cert pinning, token auth, rate-limit, approval gates, TTL approval (default REJECT), sandbox bash, egress allowlist. Kalau suatu fitur butuh "bypass", STOP dan tanya, jangan akali.
3. **JANGAN mengirim data user ke layanan pihak ketiga** selain model provider yang dipilih user (spec §1, §6). Tanpa telemetry, tanpa analytics, tanpa error reporting cloud.
4. **JANGAN menulis ulang filosofi**: tidak boleh menambahkan akun cloud, hosted relay, atau sync service milik kita.
5. **JANGAN menambah dependency baru tanpa cek yang sudah ada** (lihat §5) dan tanpa persetujuan. Dependency experimental harus di-pin versinya (spec §8).
6. **JANGAN memakai sandbox Vercel** (`@ai-sdk/sandbox-vercel`) untuk mode Full — Pi wajib host-process (`@ai-sdk/sandbox-just-bash`). Ini keputusan filosofi, bukan teknis.
7. **JANGAN claim "done" tanpa menjalankan test** yang membuktikan. Self-report = bukti; test hijau = bukti.
8. **JANGAN install library untuk hal yang bisa diselesaikan dengan stdlib atau dependency yang sudah ada** (detail §5).

## 4. Cara Menulis Kode yang Efisien

1. **Sederhana dulu, jelas selalu.** Satu unit = satu tanggung jawab. Kalau file >400 baris, pecah.
2. **TypeScript strict** di semua package (sidecar + app). No `any` kecuali di boundary eksternal yang terdokumentasi.
3. **Tool loop & agent core tipis** — logika routing/agent di sidecar, bukan di UI HP. HP cuma renderer (spec §3.2).
4. **Event schema tunggal:** kedua mode (Cepat/Lite & Lengkap/Full) harus memancarkan event ke SATU trace schema kita sendiri (spec §7.1, §11.3). Jangan biarkan dua format trace.
5. **Approval gate idempotent & kontekstual:** diff penuh + hash command; allowlist per-workspace. Jangan pernah auto-approve.
6. **Error message bahasa manusia** di sisi user (lihat `anythingpocket doctor` sebagai contoh gaya), detail teknis masuk log file.
7. **Copy UI ditulis sebelum coding UI** (bilingual EN+ID, outcome-oriented, bukan jargon stack — spec §7.9).
8. **Test menyertai kode:** unit test untuk logika murni, integration test untuk WS/agent loop (sidecar harus bisa dites via `wscat` tanpa HP).
9. **Commit kecil & atomik**, message jelas, satu commit satu maksud. Tulis file incremental per bagian (schema → shared → endpoint → test) supaya hasil parsial selamat kalau sesi putus.

## 5. Gunakan yang Ada Dulu SEBELUM Install Baru

Cek urutan ini tiap kali butuh kemampuan baru:

1. **Stdlib** (node:crypto, node:fs, node:path, WebSocket bawaan runtime, dsb).
2. **Dependency yang sudah ada di package.json** — baca dulu daftar dependensi sebelum menambah apa pun.
3. **Library yang sudah dipilih spec (§8)** — ini stack resmi, jangan diganti:
   - App: React Native (fork upstream), NativeWind
   - Sidecar: Node.js/Bun + TypeScript
   - Agent Cepat: AI SDK 5 (`ai`) — provider layer + tool loop
   - Agent Lengkap: `@ai-sdk/harness` + `@ai-sdk/harness-pi` + `@earendil-works/pi-coding-agent` (MIT, host-process; nama tanpa suffix tidak ada di npm)
   - Sandbox lokal: `@ai-sdk/sandbox-just-bash`
   - MCP: `@modelcontextprotocol/sdk` (STABIL — bukan experimental client AI SDK)
   - State: SQLite (sidecar), RN storage (HP)
   - Transport: WebSocket (`ws`) + TLS self-signed + cert pinning
   - Notifikasi: WebPush VAPID / ntfy (FCM opsional, payload disanitasi)
4. **Kalau benar-benar butuh library baru**, wajib tulis 2 kalimat di PR/desk: kenapa stdlib & dependency existing tidak cukup, lisensi apa, ukurannya berapa, dan apakah masih dimaintain. Tanpa itu, ditolak.
5. **Dilarang menambah**: framework agent kedua, ORM berat, CSS framework baru, state manager baru, dan hal serupa yang menggandakan abstraksi yang sudah ada.

## 6. Definisi Selesai (acceptance criteria)

- [ ] Kode + test hijau dijalankan (bukan diklaim)
- [ ] Trace event mengikuti schema tunggal
- [ ] Tidak ada secrets di log/trace/repo
- [ ] Docs 1 paragraf (artifact leave-behind)
- [ ] Spec tidak dilanggar — kalau ada konflik dengan spec, STOP dan tandai untuk meeting, jangan mutusin sendiri
