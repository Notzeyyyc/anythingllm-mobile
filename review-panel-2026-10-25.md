# Hasil Meeting Panel Review Spec "Pocket Harness" — 25 Okt 2026

Panel: 3 sub-agent (Arsitek Skeptis, Pragmatis Eksekusi, User Advocate). Spec: `spec-2026-10-25-pocket-harness.md`.

## Konsensus panel (semua sepakat)

1. **Arsitektur & filosofi TIDAK diubah** — thin-client + sidecar, local-first, router deterministik, non-goal eksplisit: semua dipertahankan.
2. **Bash sandbox bukan sandbox** — mitigasi "low-privilege user + approval gate" dianggap TIDAK CUKUP (env vars bocor, egress bebas, blind-click approval). Wajib: container/landlock/bubblewrap + secrets via proxy server-side (agent tak pernah lihat API key). Syarat rilis.
3. **TOFU manual entry = lubang MITM** — manual entry wajib verifikasi fingerprint kedua-kali-tampil (bandingkan SHA256 di HP vs layar server), bukan auto-pull. Klaim "MITM tidak mungkin" dihapus. Tambah rate-limit/lockout (5 handshake gagal/IP).
4. **FCM/APNs kontradiksi filosofi** — ganti: WebSocket foreground + WebPush VAPID self-hostable / ntfy. FCM cuma opsional dengan payload sanitasi + didokumentasikan.
5. **Approval pending butuh TTL + default REJECT** (bukan approve) saat HP offline — catat di trace.
6. **Server = source of truth; HP cache read-only** — hapus "last-write-wins dua arah" (resep data loss). Memory sync dua arah ditunda ke backlog.
7. **Spike Pi 3–5 hari SEBELUM M2** — go/no-go gate: lifecycle callbacks cukup buat trace viewer atau tidak. §11.2 (runtime final) diselesaikan lewat spike ini.
8. **Trace schema kita sendiri** — normalize Lite & Full ke satu event schema (jawaban §11.3). MCP client pakai `@modelcontextprotocol/sdk` yang stabil, bukan experimental AI SDK.
9. **Roadmap over-estimate ~2x → restrukturisasi** (lihat v2 di spec): Fleet view & memory sync → backlog; M2 dipecah M2a (Full + approval + trace basic = minimum demo-able) / M2b (MCP + skills + trace raw); Tailscale-first transport di M1, direct TLS+pinning ke M3 (risiko ATS iOS & pinning RN nyata); spike iOS ATS di minggu pertama.
10. **UX harus di-de-jargonisasi**: rename Lite→"Cepat", Full→"Lengkap"; 3 mode transport disembunyiin jadi satu status "✅ Tersambung (aman, terenkripsi)"; trace viewer 3 tingkat (Rangkuman → Detail → Raw/"mode belajar") + export; installer `--dry-run/--explain` + `pocketharness doctor`; alur re-pairing 1 layar; installer non-curl (`npx`/compose).
11. **Delegasi sub-agent: tiap task wajib leave-behind artifact** (script + test + docs 1 paragraf) — biar resumable pas provider drop.
12. **§11.4 bahasa UI: bilingual tiered** — UI inti EN+ID, copy one-line penjelasan ditulis SEBELUM coding UI.

## Ketidaksepakatan (dan penyelesaiannya)

- **Skeptis** mau gateway "chat murni" jadi tier ketiga + eskalasi mid-run Lite→Full; **Pragmatis** bilang tambah kompleksitas. **Penyelesaian:** router boleh eskalasi mid-run (Lite mulai, eskalasi kalau tool miss terdeteksi) — tapi tanpa tier ketiga dulu; masuk backlog.
- **Skeptis** minta benchmark angka nyata (image size, RAM); **Pragmatis** setuju → jadi acceptance criteria M1 (perf budget terukur, bukan "~100MB").

## Verdict panel

Layak dieksekusi dengan revisi. Revisi diterapkan ke spec **v1.1** (25 Okt 2026).
