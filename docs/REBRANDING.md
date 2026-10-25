# Rebranding Notice (GPLv3 §5(a))

Dokumen ini mencatat modifikasi terhadap AnythingLLM Mobile oleh Mintplex Labs sesuai ketentuan GNU General Public License v3 §5(a). Proyek ini difork dengan nama **AnythingPocket** oleh Notzeyyyc.

Perubahan utama yang dilakukan mencakup:
1. Rebranding teks antarmuka dan persona aplikasi menjadi AnythingPocket di seluruh 17 berkas lokalisasi (`src/locales/*`), prompt asisten, kartu quick context, metadata ekspor chat (PDF, DOCX, PPTX), User Settings, serta dokumentasi.
2. Penghapusan telemetri cloud Firebase dan Crashlytics (`src/utils/Telemetry` dijadikan no-op lokal tanpa sink eksternal).
3. Penambahan Harness Companion sidecar (`sidecar/`) untuk mengeksekusi agent harness penuh (file operations, MCP, skills, loop otonom) di server milik pengguna sendiri dengan thin-client trace viewer.

Entitas upstream tertentu sengaja dipertahankan tanpa perubahan untuk menjaga kompatibilitas ekosistem dan kepatuhan lisensi: deep link scheme `anythingllm://`, konektor instance eksternal `AnythingLLMExternal` beserta header otentikasinya, referensi koneksi AnythingLLM Desktop / Server, tautan repositori serta lisensi GPLv3 dari Mintplex Labs.
