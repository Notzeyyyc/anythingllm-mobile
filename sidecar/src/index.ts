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

const srv = startServer();
console.log(`AnythingPocket sidecar listening on ws://${srv.bind}:${srv.port}/ws`);

async function shutdown(): Promise<void> {
  console.log('Shutting down...');
  await srv.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
