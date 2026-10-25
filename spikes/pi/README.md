# Spike Pi — M0 (AnythingPocket)

Pertanyaan spike (spec §4.2 SPIKE GATE): bisakah `@ai-sdk/harness` + `@ai-sdk/harness-pi`
(Pi sebagai **host-process**, bukan sandbox Vercel) jalan di Node lokal dengan agent loop
+ tool execution nyata, dan apakah lifecycle callbacks-nya cukup untuk trace viewer (§7.1)?

**Verdict: GO.** Detail di bawah.

## Cara jalanin

```bash
cd spikes/pi
npm install
npm run spike          # = npx tsx run-spike.ts
```

Model provider: 9router lokal, OpenAI-compatible. Key dibaca saat runtime dari
`/root/.secrets/9router_local_key.txt` (jangan pernah di-commit). Kalau model
`ngd/ngodeai/gemini-3.8-flash` mati, cek `/v1/models` dan ganti model prefix
`ngd/` atau `rdnamd/` di `run-spike.ts` (jangan `knri/` atau `tknh/`).

## Hasil aktual (2 run beruntun, keduanya exit 0)

```
PASS: trace has >10 events (23)
PASS: all 7 lifecycle event types present (end,lm_end,lm_start,step_end,step_start,tool_end,tool_start)
PASS: >=2 tool_start events (3)
PASS: every tool_start has matching tool_end (3 toolCallIds)
PASS: agent used Pi write tool
PASS: write targeted summary.txt (/home/user/pi-.../summary.txt)
PASS: summary.txt content persisted in sandbox overlay (Kopi pagi penting dan ...)
PASS: no API key material leaked into trace
EVENT COUNTS: {"step_start":4,"lm_start":4,"tool_start":3,"tool_end":3,"lm_end":4,"step_end":4,"end":1}
```

Agent loop nyata: model memanggil tool host `read_file` + `list_dir` (didefinisikan di
`tools.ts`, di-sandbox ke `spikes/pi/workspace`), lalu tool builtin Pi `write`. Trace
lengkap ada di `out/trace.jsonl` (23 event, JSONL satu-baris-per-event).

## API yang dipakai (aktual, bukan spek)

- `createPi(settings)` dari `@ai-sdk/harness-pi` → objek `HarnessV1` (adapter), in-process,
  tanpa bridge. Provider OpenAI-compatible custom didaftarkan via `settings.providers`:
  `{ baseUrl, apiKey, models: [{ id, name, api: 'openai-completions', input, reasoning,
  contextWindow, maxTokens, cost }] }`, lalu `model: '<provider>/<model-id>'`.
- `new HarnessAgent({ harness, model, tools, permissionMode, instructions, ...callbacks })`
  dari `@ai-sdk/harness/agent`. Callbacks yang terbukti hidup: `onStepStart`,
  `onStepEnd`, `onLanguageModelCallStart`, `onLanguageModelCallEnd`,
  `onToolExecutionStart`, `onToolExecutionEnd`, `onEnd` — persis nama yang spekan §4.2.
- Sandbox wajib: `createSession()` tanpa sandbox throw. Pakai
  `@ai-sdk/sandbox-just-bash` (spec §8, host-process) dengan `OverlayFs` ber-root di
  `workspace/` — baca dari disk nyata, tulis masuk layer in-memory, tidak bisa keluar root.
- `agent.generate({ session, prompt })` menjalankan tool loop sampai selesai.

## Pemetaan event aktual → harapan spec §7.1

Satu schema JSONL sudah cukup informatif untuk 3 tingkat trace viewer:

| Field aktual | Type event | Pakai untuk (tingkat viewer) |
|---|---|---|
| `seq`, `ts`, `type` | semua | urutan + timeline |
| `callId` | semua | korelasi antar event dalam satu turn |
| `stepNumber` | `step_start`/`step_end` | ① "Step 3/4" |
| `modelId`, `provider` | `lm_start`/`lm_end` | ① badge model |
| `toolName`, `input` | `tool_start` | ② "baca file notes.txt" |
| `toolCallId`, `toolExecutionMs`, `toolOutput` | `tool_end` | ② durasi + hasil, ③ raw JSON |
| `finishReason`, `usage` | `lm_end`/`step_end` | ① ringkasan token/biaya |

Yang spec §7.1 harapkan tapi belum diuji di spike ini: reasoning stream (model ini
non-reasoning), file-change events, approval flow (`permissionMode` dipakai
`allow-all` — approval gate + TTL default REJECT wajib diuji di M1 sebelum dipakai nyata).

## Kejutan & limitasi

1. **Sandbox bukan opsional** — `HarnessAgent.createSession()` throw tanpa
   `sandboxSession`. Dokumen harness menyinggung ini tapi error-nya baru ketemu saat run.
   `@ai-sdk/sandbox-just-bash` + `OverlayFs` jawab kebutuhan host-process.
2. **Tulisan sandbox in-memory** — file yang agent `write` TIDAK mendarat di disk nyata
   (OverlayFs copy-on-write), dan `session.stop()` membuangnya. Ini fitur keamanan, bukan
   bug. Kalau M1 butuh persist hasil, salin keluar via `sandboxSession.readTextFile()`
   sebelum stop (seperti yang dilakukan assert) atau pakai `overlayRoot`→persist lain.
3. **`session.stop()` setelah `generate()` selesai = throw** "session is not active".
   Generate sudah mengakhiri session. Bungkus try/catch atau panggil hanya untuk
   early-abort. (Selesai terdokumentasi sebagian di docstring `detach/stop/destroy`.)
4. **Quirk router non-streaming** — endpoint chat/completions router menambah trailing
   `data: [DONE]` setelah JSON body. Harness/Pi jalan streaming secara default jadi tidak
   kena, tapi `generateText` non-stream manual akan gagal parse.
5. **Model pool kecil** — butuh model yang support tool calling lewat
   `openai-completions`; `gemini-3.8-flash` (via `ngd/ngodeai/`) terbukti. Fallback:
   prefix `rdnamd/`. Prefix `knri/`, `tknh/` → 401/402.
6. **Versi di-pin** (spec §8: experimental = pin): `@ai-sdk/harness@1.0.164`,
   `@ai-sdk/harness-pi@1.0.167`, `ai@7.0.153`, `@ai-sdk/sandbox-just-bash@1.0.164`,
   `zod@4.6.7` (lihat package.json + package-lock.json). API-nya masih bergerak —
   di 1.0.x sudah ada rename deprecation (`experimental_onToolCallStart` →
   `onToolExecutionStart`), jadi abstraksi `HarnessRuntime` (spec §4.2) tetap wajib
   sebagai tameng breaking change.

## Verdict: GO

- Agent loop + tool execution host-process: **terbukti** (3 tool calls, 2 host tools +
  1 builtin Pi tool, hasil tulis terverifikasi balik).
- Lifecycle callbacks cukup untuk trace viewer: **ya** — semua event berpasangan
  start/end, satu `callId` mengorelasikan satu turn, field input/output/durasi/usage
  cukup untuk rangkuman ① dan detail ②. Schema tunggal Lite/Full bisa diturunkan
  langsung dari event ini (jawaban §11.3).
- §11.2 (runtime final): **Pi host-process dikonfirmasi** sebagai runtime mode Lengkap.
  Risiko utama tersisa: API experimental (pin + abstraksi), approval flow belum diuji,
  persist tulisan sandbox perlu keputusan desain di M1.
