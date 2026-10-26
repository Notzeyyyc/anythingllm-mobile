# M3 — Direct TLS Mode + Background Jobs & Push

Tanggal: 26 Okt 2026. Semua fitur di bawah ada test-nya di
`sidecar/test/m3.test.ts` (`npm test`, suite m3: 29 assert).

## Mode direct (spec §3.3)

Sidecar kini bisa di-expose langsung ke IP publik via WSS + TLS self-signed:
cert di-generate openssl CLI (`CN=AnythingPocket`, SAN loopback + IP utama +
hostname, default via env `POCKET_SAN`, masa berlaku 10 tahun) dan disimpan di
`sidecar/data/{cert,key}.pem` (0600). Pairing payload (spec §5.1) kini selalu
dicetak oleh `--init-pairing` dan — di mode direct — memuat `cert_fp`
(`sha256:<hex>` dari DER cert) yang wajib diverifikasi kedua-kali-tampil di HP
(TOFU/pinning, spec §6). Enable: `bash install.sh --direct` (panduan firewall +
peringatan port publik) atau env `POCKET_TLS=on` (auto: pakai TLS kalau cert
sudah ada; off: plain ws:// meski cert ada). Default TETAP bind `127.0.0.1`
plain ws:// — mode tailscale M1 tidak berubah. `--cloudflare` memandu
cloudflared tunnel tanpa auto-install (domain milik user). Client normal
menolak self-signed CA (terverifikasi di test); app memverifikasi `cert_fp`
dan pin. **Catatan iOS: spike ATS masih BLOCKED (tidak ada Mac) — mode direct
belum diklaim jalan di iOS.**

## Background jobs + notifikasi (spec §7.6)

Turn agent berjalan async di server; kalau HP disconnect mid-turn, loop tetap
jalan sampai selesai dan history (user + assistant) tersimpan di SQLite —
terverifikasi test (d) yang memutus koneksi di tengah streaming. Saat
`turn.end` atau `approval.requested` terjadi dan device TIDAK punya koneksi WS
hidup, sidecar mengirim push: **WebPush VAPID** (dep `web-push` 3.6.7, keys
di-generate sekali & disimpan di DB) dan/atau **ntfy** (env `POCKET_NTFY_URL`
+ `POCKET_NTFY_TOPIC`). FCM sengaja tidak ada. HP subscribe via pesan WS
`push.subscribe {subscription:{endpoint, keys:{p256dh,auth}}}` (endpoint
dipangkas otomatis kalau 404/410). **Payload disanitasi keras (spec §6):**
hanya `title` fixed ("Turn selesai…"/"Approval dibutuhkan…") + `sessionId` —
tidak pernah ada prompt, hasil, command, atau diff, karena push service adalah
pihak ketiga. Diuji: payload keys minimal + tidak ada string prompt di payload.
