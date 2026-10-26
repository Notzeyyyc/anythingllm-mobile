# M3 — Routing & Compute + Cert TOFU (kontrak v1.2)

## Routing & Compute (spec §4.4)

Halaman **Settings → Routing & Compute** (`pocket_routing` di UserSettings) menyimpan preferensi di AsyncStorage (`pocket.routing`): mode `manual|smart` (default manual), runtime pin (Cepat/Lite atau Lengkap/Full), preferensi task ringan (on-device/server), fallback policy (`on-device|stop`, default on-device).

Kontrak turn.request **v1.2** (additive; server lama mengabaikan field baru):

```json
{ "type": "turn.request", "turnId": "...", "prompt": "...", "runtime": "lite|full" }
```

- **Manual**: HP mengirim `runtime` = pin user (bisa di-override per chat). Server boleh menimpa (mis. `POCKET_FORCE_RUNTIME`) dan melaporkan keputusan via event trace `route.decided`.
- **Smart**: HP **tidak mengirim** `runtime` — router server yang menentukan; HP hanya menampilkan `route.decided`. Preferensi task ringan (`lightCompute`) dibaca server via config, bukan dikirim HP.

## Hybrid fallback (spec §7.8)

Kalau koneksi give-up (status `disconnected`) dan fallback policy `on-device`: banner "mode offline" di area chat + tombol lanjut ke chat upstream (jalur llama.rn on-device yang sudah ada), riwayat Pocket tetap terbaca, dan retry server berjalan di latar belakang (setiap 60s via `reconnectPocket`). Policy `stop`: tidak ada fallback, hanya banner.

## Cert pinning / TOFU — keputusan jujur

**Transport-level pinning TIDAK diimplementasi.** WebSocket RN tidak punya hook pinning. Opsi yang ditolak:

- `react-native-ssl-pinning`: native module terpisah, maintenance buruk, risiko build; melanggar semangat AGENTS.md §5.
- patch-package interceptor OkHttp: paling jujur secara TLS, tapi patch native di zona android/ (di luar zona M3 app) dan rawan konflik tiap upgrade RN.

**Yang diimplementasi (aplikasi-level, TOFU dua-kali-tampil, spec §6):**

1. Sidecar mengirim `certFp` di `auth.ok` (koordinasi agent A; field opsional — kalau tidak ada, HP tidak menampilkan apa pun).
2. Pertama kali terlihat → kartu verifikasi menampilkan fingerprint; user bandingkan dengan layar server, konfirmasi → tersimpan di AsyncStorage (`pocket.certFp`, bukan secret).
3. Koneksi berikutnya dengan fingerprint berbeda → peringatan merah (mungkin ada yang menyamar), tidak tersimpan otomatis.
4. **Challenge opsional (additive)**: sidecar boleh mengirim setelah `auth.ok` → `{"type":"auth.challenge","nonce":"...","mac":"<hex>"}` dengan `mac = HMAC-SHA256(key = fingerprint hex, msg = nonce)`. HP verifikasi (pure-JS SHA-256/HMAC, tanpa dependency baru — Hermes tidak punya node:crypto). Gagal = koneksi ditutup seperti `auth.deny`.

**Trade-off yang harus dipahami:** challenge ini **bukan** pinning TLS. Fingerprint bukan secret, jadi HMAC-nya tidak membuktikan server memegang private key cert — yang dibuktikan hanyalah peer mengetahui fingerprint yang sudah diverifikasi user (memutus relay naive yang membuka sesi TLS-nya sendiri tanpa meneruskan frame aplikasi). Perlindungan MITM yang sebenarnya tetap datang dari perbandingan TOFU + TLS self-signed itu sendiri; pinning transport penuh menunggu keputusan patch native (backlog, butuh sentuhan android/).

**Follow-up (sengaja tidak dikerjakan di M3 ini):** step "Routing & Compute" belum disisipkan otomatis di alur onboarding setelah pairing (halaman bisa di-skip dan bisa dibuka dari Settings — sesuai §4.4 "opsional"); sisipkan di navigator onboarding kalau ingin step eksplisit.
