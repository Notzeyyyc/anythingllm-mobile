# M2b — MCP + Skills (sidecar)

**Arsitektur (1 paragraf).** MCP dan Skills hidup di sidecar sebagai modul terpisah yang di-wire ke kedua runtime. MCP (`src/mcp.ts`) pakai SDK stabil `@modelcontextprotocol/sdk`: config dibaca dari `POCKET_MCP_CONFIG` (default `<dataDir>/mcp.json`, lihat `mcp.json.example`), server stdio (command+args) dan HTTP (`url`) di-connect saat startup; tool tiap server di-cache dengan nama prefixed `mcp_<server>_<tool>` agar tidak pernah tabrakan dengan tool builtin; server mati/config rusak hanya menghasilkan event trace `mcp.server.status` (status `failed`/`config-error`) — startup tidak pernah crash, reconnect via `McpManager.reconnect()` yang juga me-refresh cache tool. Skills (`src/skills.ts`) read-only: folder `POCKET_SKILLS_DIR` (default `<dataDir>/skills/`) berisi `<skill-name>/SKILL.md` format agentskills.io (frontmatter YAML `name`+`description` + body markdown), diindeks saat startup, dan diload kontekstual secara **deterministik** (keyword match case-insensitive prompt vs name+description, top-2) — body skill yang match di-inject ke prompt turn itu dan event `skill.loaded {skill, matchedOn}` masuk trace. Kedua event baru masuk whitelist schema tunggal (`schema.ts`) sehingga otomatis ter-push via WS tanpa message baru.

**Keputusan sandbox: MCP server jalan di HOST process**, bukan di dalam bwrap. Alasan: MCP server adalah proses eksternal yang user pilih sendiri lewat `mcp.json` — tingkat kepercayaannya setara sidecar itu sendiri (trusted-by-choice). Sandbox ada untuk mengandung bash yang dihasilkan model, bukan untuk memenjarakan proses yang user approve secara eksplisit. Env MCP server boleh mereferensikan env user (`"env": {"MY_TOKEN": "$MY_TOKEN"}` di-resolve dari env sidecar) — jangan hardcode secrets di config.

**Status MCP di Pi (Full mode): AKTIF via native support.** `@earendil-works/pi-coding-agent` + `@ai-sdk/harness-pi` punya dukungan MCP native yang sudah diverifikasi di node_modules: `createPi()` menerima opsi `mcpServers` (tools bernama `mcp__<server>__<tool>`, server di-spawn per harness session, tanpa baca file mcp.json sendiri). `pi-runtime.ts` me-load config mcp.json yang sama dan meneruskannya; config rusak → degradasi ke tanpa MCP, turn tetap jalan. Jadi MCP jalan di Lite (proxy manager) DAN Full (native Pi).

## Cara menambah MCP server

1. `cp sidecar/mcp.json.example <dataDir>/mcp.json`, edit: stdio → `{"command":"npx","args":[...]}`, HTTP → `{"url":"https://...","headers":{...}}`.
2. Restart sidecar / run Lite CLI baru. Cek trace event `mcp.server.status` (connected/failed + jumlah tool).
3. Tool muncul otomatis ke model dengan nama `mcp_<server>_<tool>` (Lite) atau `mcp__<server>__<tool>` (Full/Pi).

## Cara menambah skill

1. `mkdir -p <dataDir>/skills/<nama>/` dan tulis `SKILL.md` (contoh: `docs/skills-example/`):
   ```markdown
   ---
   name: commit-style
   description: how to write git commit messages here
   ---
   body markdown…
   ```
2. Tidak perlu restart untuk CLI baru (index per run). Skill diload hanya kalau prompt mengandung keyword dari name/description — tidak ada LLM classifier, keputusan bisa direplay dari trace.
