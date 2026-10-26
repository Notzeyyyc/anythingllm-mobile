/**
 * AnythingPocket sidecar — entrypoint.
 *   node --experimental-strip-types src/index.ts            → start server
 *   ... --init-pairing                                      → print pairing token (redacted)
 *   ... --init-pairing --show-token                         → print full token once (screen only)
 *   ... --doctor                                            → health checks
 * Env: PORT (default 7443), BIND (default 127.0.0.1).
 */
import { openDb } from './db.ts';
import { issuePairingToken, redact } from './auth.ts';
import { startServer, setDbApi } from './ws.ts';
import { doctorMain } from './doctor.ts';
import { PiRuntime } from './full/pi-runtime.ts';
import { startSecretsProxy, readKeyFromFile } from './secrets-proxy.ts';
import { fullModelConfig } from './router.ts';
import * as dbmod from './db.ts';
import * as https from 'node:https';
import { DEFAULT_DATA_DIR, ensureCert, tlsMode, buildPairingPayload } from './tls.ts';
import { initNotify } from './notify.ts';

const args = process.argv.slice(2);

if (args.includes('--doctor')) {
  const code = await doctorMain();
  process.exit(code);
}

const dbh = openDb();
setDbApi(dbmod);
initNotify(dbh); // VAPID keys generated/loaded from DB; push_subs table ready

// --- direct mode (spec §3.3): WSS with self-signed cert ----------------------
// Default bind stays 127.0.0.1 for the plain listener; TLS (public exposure)
// binds 0.0.0.0 explicitly — direct mode is the deliberate open-port decision.
const tls = ensureCert(DEFAULT_DATA_DIR);
let httpServer: https.Server | null = null;
if (tls) {
  httpServer = https.createServer({ cert: tls.cert, key: tls.key });
  httpServer.listen(Number(process.env.PORT ?? 7443), process.env.BIND ?? '0.0.0.0');
  console.log(`TLS: WSS direct mode aktif (cert_fp ${tls.certFp})`);
} else {
  console.log(`TLS: tidak aktif (POCKET_TLS=${tlsMode()}, tanpa cert di ${DEFAULT_DATA_DIR}) — plain ws:// (mode tailscale, M1 kompatibel).`);
}

if (args.includes('--init-pairing')) {
  const p = issuePairingToken();
  const show = args.includes('--show-token');
  console.log('Pairing token / Token pairing:');
  console.log(show ? p.token : redact(p.token));
  if (!show) {
    console.log('(ter-redaksi. Tambahkan --show-token untuk melihat token penuh sekali di layar / redacted. Add --show-token to print the full token once.)');
  }
  const payload = buildPairingPayload({
    token: p.token, expiresAt: p.expiresAt, tls, port: Number(process.env.PORT ?? 7443),
    host: process.env.POCKET_PUBLIC_HOST,
  });
  console.log('\nPairing payload (QR / manual entry, spec §5.1):');
  console.log(JSON.stringify(payload, null, 2));
  if (tls) {
    console.log('\nVerifikasi kedua-kali-tampil (spec §6): pastikan cert_fp di HP');
    console.log(`SAMA dengan di atas: ${tls.certFp}`);
  }
  console.log('Masukkan token ini di HP lewat pairing manual / enter this token on your phone via manual pairing.');
}

// Full mode (spec §4.2/§6): Pi host-process + secrets proxy. The real API key
// stays in the PARENT process; the Pi runtime only sees POCKET_PROXY_URL.
let fullRuntime;
if (process.env.POCKET_FULL !== '0') {
  try {
    const { baseUrl, model } = fullModelConfig();
    const proxy = await startSecretsProxy({ upstreamBase: baseUrl, key: readKeyFromFile(process.env.POCKET_API_KEY_FILE ?? '/root/.secrets/9router_local_key.txt') });
    console.log(`Secrets proxy on ${proxy.url} (key server-side only)`);
    fullRuntime = new PiRuntime({ baseUrl: proxy.url, apiKey: 'via-secrets-proxy', model, proxySocketPath: proxy.socketPath });
  } catch (e) {
    console.log(`Full mode disabled (secrets proxy/model config unavailable: ${e instanceof Error ? e.message : e}) — turns route to Lite.`);
  }
}

const srv = startServer({
  fullRuntime,
  forceRuntime: process.env.POCKET_FORCE_RUNTIME ?? null,
  ...(httpServer ? { server: httpServer } : {}),
  ...(tls ? { certFp: tls.certFp } : {}),
});
console.log(`AnythingPocket sidecar listening on ${tls ? 'wss' : 'ws'}://${srv.bind}:${srv.port}/ws`);

async function shutdown(): Promise<void> {
  console.log('Shutting down...');
  await srv.close();
  httpServer?.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
