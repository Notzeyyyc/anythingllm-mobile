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

const args = process.argv.slice(2);

if (args.includes('--doctor')) {
  const code = await doctorMain();
  process.exit(code);
}

openDb();
setDbApi(dbmod);

if (args.includes('--init-pairing')) {
  const p = issuePairingToken();
  const show = args.includes('--show-token');
  console.log('Pairing token / Token pairing:');
  console.log(show ? p.token : redact(p.token));
  if (!show) {
    console.log('(ter-redaksi. Tambahkan --show-token untuk melihat token penuh sekali di layar / redacted. Add --show-token to print the full token once.)');
  }
  console.log(`Kedaluwarsa / expires: ${new Date(p.expiresAt).toISOString()}`);
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
    fullRuntime = new PiRuntime({ baseUrl: proxy.url, apiKey: 'via-secrets-proxy', model });
  } catch (e) {
    console.log(`Full mode disabled (secrets proxy/model config unavailable: ${e instanceof Error ? e.message : e}) — turns route to Lite.`);
  }
}

const srv = startServer({
  fullRuntime,
  forceRuntime: process.env.POCKET_FORCE_RUNTIME ?? null,
});
console.log(`AnythingPocket sidecar listening on ws://${srv.bind}:${srv.port}/ws`);

async function shutdown(): Promise<void> {
  console.log('Shutting down...');
  await srv.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
