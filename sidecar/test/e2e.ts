/**
 * AnythingPocket sidecar — e2e test (real WS over loopback TCP, no HP needed).
 * Run: npm test  (node --experimental-strip-types test/e2e.ts)
 * Exit 0 = all green. Plain asserts, no test framework.
 *
 * Scenarios (task spec):
 *  (a) connect without token → rejected
 *  (b) connect with garbage token → rejected
 *  (c) 5x wrong token from 1 IP → lockout (even valid token blocked after)  [runs last: poisons loopback IP]
 *  (d) valid pairing token → session token issued
 *  (e) reconnect with session token → ok, no re-pair
 *  (f) approval with TTL 2s, no response → auto REJECT (expired) recorded in events
 *  (g) revoke device → session token dead
 */
import { openDb, closeDb, listEvents, getApproval } from '../src/db.ts';
import { issuePairingToken, _resetLockout } from '../src/auth.ts';
import { startServer, setDbApi } from '../src/ws.ts';
import * as dbmod from '../src/db.ts';
import * as authmod from '../src/auth.ts';

let passed = 0, failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ok - ${label}`); }
  else { failed++; console.error(`  FAIL - ${label}`); }
}

// --- tiny WS client helper on Node native WebSocket -------------------------
function connect(url: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('connect failed'));
  });
}
function sendMsg(ws: WebSocket, msg: object): void { ws.send(JSON.stringify(msg)); }
/** Wait for one message matching pred, with timeout ms. */
function waitMsg(ws: WebSocket, pred: (m: any) => boolean, ms = 3000): Promise<any> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { ws.removeEventListener('message', h); rej(new Error('timeout waiting message')); }, ms);
    const h = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data));
      if (pred(m)) { clearTimeout(t); ws.removeEventListener('message', h); res(m); }
    };
    ws.addEventListener('message', h);
  });
}
/** Wait for close; resolve {code, reason}. */
function waitClose(ws: WebSocket, ms = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((res) => {
    const t = setTimeout(() => res({ code: -1, reason: 'no close (timeout)' }), ms);
    ws.onclose = (ev) => { clearTimeout(t); res({ code: ev.code, reason: ev.reason }); };
  });
}

const PORT = 17443;
const URL = `ws://127.0.0.1:${PORT}/ws`;

async function main(): Promise<void> {
  openDb(':memory:');
  setDbApi(dbmod);
  const srv = startServer({ port: PORT, bind: '127.0.0.1' });

  // --- (a) no token: first message is not auth → protocol close
  console.log('(a) connect tanpa token / without token');
  {
    const ws = await connect(URL);
    sendMsg(ws, { type: 'ping' });
    const c = await waitClose(ws);
    ok(c.code === 4003, `ditolak, close code ${c.code} (want 4003)`);
  }

  // --- (b) garbage token
  console.log('(b) connect token ngaraco / garbage token');
  {
    const ws = await connect(URL);
    sendMsg(ws, { type: 'auth', token: 'hbk_' + 'f'.repeat(64) });
    const m = await waitMsg(ws, (x) => x.type === 'auth.deny');
    const c = await waitClose(ws);
    ok(!!m.reason && c.code === 4003, `auth.deny ("${m.reason}") + close ${c.code}`);
  }

  // --- (d) valid pairing token → session token
  console.log('(d) pairing token valid → session token');
  let sessionToken = '', deviceId = '';
  {
    const { token } = issuePairingToken(60_000);
    const ws = await connect(URL);
    const authed = waitMsg(ws, (x) => x.type === 'auth.ok' || x.type === 'auth.deny');
    sendMsg(ws, { type: 'auth', token });
    const m = await authed;
    ok(m.type === 'auth.ok', 'auth.ok diterima');
    ok(typeof m.sessionToken === 'string' && m.sessionToken.startsWith('hbs_'), 'session token hbs_ di-issue');
    ok(m.sessionToken !== token, 'session token != pairing token');
    sessionToken = m.sessionToken; deviceId = m.deviceId;
    // pairing token is single-use: reuse must fail
    const ws2 = await connect(URL);
    sendMsg(ws2, { type: 'auth', token });
    const m2 = await waitMsg(ws2, (x) => x.type === 'auth.deny');
    ok(m2.type === 'auth.deny', 'pairing token single-use (reuse ditolak)');
    ws2.close();
    // session works
    sendMsg(ws, { type: 'session.start' });
    const sm = await waitMsg(ws, (x) => x.type === 'session.started');
    ok(typeof sm.sessionId === 'string', `session.started (${sm.sessionId.slice(0, 8)}...)`);
    ws.close();
  }

  // --- (e) reconnect with session token (no re-pair)
  console.log('(e) reconnect pakai session token');
  {
    const ws = await connect(URL);
    sendMsg(ws, { type: 'auth', token: sessionToken });
    const m = await waitMsg(ws, (x) => x.type === 'auth.ok' || x.type === 'auth.deny');
    ok(m.type === 'auth.ok' && m.deviceId === deviceId, 'reconnect sukses, device sama');
    ok(m.sessionToken === undefined, 'tidak re-issue session token (no re-pair)');
    ws.close();
  }

  // --- (f) approval TTL 2s, no response → auto REJECT (expired), tercatat di events
  console.log('(f) approval TTL 2s tanpa jawaban → auto REJECT');
  {
    const { token } = issuePairingToken(60_000);
    const ws = await connect(URL);
    sendMsg(ws, { type: 'auth', token });
    await waitMsg(ws, (x) => x.type === 'auth.ok');
    sendMsg(ws, { type: 'session.start' });
    const { sessionId } = await waitMsg(ws, (x) => x.type === 'session.started');

    sendMsg(ws, {
      type: 'approval.create', turnId: 'turn-f',
      payload: { tool: 'bash', command: 'rm -rf /tmp/x', ttlMs: 2000 },
    });
    const pend = await waitMsg(ws, (x) => x.type === 'approval.pending');
    ok(typeof pend.approvalId === 'string', `approval.pending (${pend.approvalId.slice(0, 8)}...)`);
    ok(new Date(pend.expiresAt).getTime() - Date.now() <= 2100, `TTL ~2s (expiresAt ${pend.expiresAt})`);

    // silence: no approval.resolve sent
    const exp = await waitMsg(ws, (x) => x.type === 'approval.expired', 5000);
    ok(exp.approvalId === pend.approvalId, 'approval.expired didorong ke client');

    const events = listEvents(sessionId);
    const types = events.map((e) => e.type);
    ok(types.includes('approval.requested') && types.includes('approval.expired'),
      `events tercatat: ${types.join(', ')}`);
    ok(getApproval(pend.approvalId)!.status === 'expired', "status DB = 'expired' (default REJECT)");
    ws.close();
  }

  // --- (g) revoke device → session token mati
  console.log('(g) revoke device → session token mati');
  {
    ok(dbmod.revokeDevice(deviceId), 'revoke per device sukses');
    const ws = await connect(URL);
    sendMsg(ws, { type: 'auth', token: sessionToken });
    const m = await waitMsg(ws, (x) => x.type === 'auth.ok' || x.type === 'auth.deny');
    ok(m.type === 'auth.deny' && /revoked/.test(m.reason ?? ''), `auth.deny ("${m.reason}")`);
    ws.close();
  }

  // --- (c) LAST: 5x wrong token from 1 IP → lockout (would poison loopback for tests above)
  console.log('(c) 5x token salah dari 1 IP → lockout');
  {
    _resetLockout(); // clean slate: only the 5 deliberate failures count
    for (let i = 0; i < 5; i++) {
      const ws = await connect(URL);
      sendMsg(ws, { type: 'auth', token: 'hbk_' + i.toString().repeat(64) });
      await waitMsg(ws, (x) => x.type === 'auth.deny');
      await waitClose(ws);
    }
    const valid = issuePairingToken(60_000);
    const ws = await connect(URL);
    sendMsg(ws, { type: 'auth', token: valid.token });
    const m = await waitMsg(ws, (x) => x.type === 'auth.deny');
    ok(/locked out/.test(m.reason ?? ''), `IP locked out — token valid pun ditolak ("${m.reason}")`);
    ws.close();
    authmod._resetLockout(); // hygiene for anyone reusing this process
  }

  // --- security: tokens never in trace
  console.log('security: token tidak pernah masuk trace/log');
  {
    ok(listEvents('__none__').length === 0, 'no stray session');
    // scan every event payload written this run
    const rows = dbmod._db().prepare('SELECT payload FROM events').all() as { payload: string }[];
    const blob = JSON.stringify(rows);
    ok(!blob.includes('hbk_') && !blob.includes('hbs_'), 'trace events bebas dari token mentah');
  }

  await srv.close();
  closeDb();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('E2E crashed:', e); process.exit(1); });
