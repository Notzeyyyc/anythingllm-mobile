/**
 * AnythingPocket sidecar — M3 tests (spec §3.3, §5.1, §6, §7.6).
 * Run: node --experimental-strip-types test/m3.test.ts — exit 0 = green.
 * Plain asserts, no framework, mock model + DB :memory:, same pattern as
 * ws-runtime.test.ts.
 *
 * (a) TLS: self-signed cert generated (openssl CLI), cert_fp format + matches
 *     the cert the client actually receives over the wire, WSS handshake works
 *     (client rejects self-signed CA unless rejectUnauthorized=false), idempotent re-gen.
 * (b) Pairing payload: spec §5.1 shape incl. cert_fp in direct mode; no cert_fp in plain mode.
 * (c) Push: payload sanitization (only title + sessionId, never prompt content),
 *     subscribe via WS → delivery only when device offline, unsubscribe, ntfy disabled default.
 * (d) Background job: device disconnects mid-turn → turn still completes, history saved.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tlsMod from 'node:tls';
import * as https from 'node:https';
import { createHash, createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { MockLanguageModelV2, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { openDb, closeDb, listEvents, listHistory, _db } from '../src/db.ts';
import { issuePairingToken } from '../src/auth.ts';
import { startServer, setDbApi } from '../src/ws.ts';
import { ensureCert, certFpOf, buildPairingPayload } from '../src/tls.ts';
import { initNotify, setPushSender, addSubscription, notifyDevice, vapidPublicKey, type PushSubscription } from '../src/notify.ts';
import * as dbmod from '../src/db.ts';

let passed = 0, failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ok - ${label}`); }
  else { failed++; console.error(`  FAIL - ${label}`); }
}
function connect(url: string, wsOpts: object = {}): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, wsOpts);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('connect failed'));
  });
}
function sendMsg(ws: WebSocket, msg: object): void { ws.send(JSON.stringify(msg)); }
function waitMsg(ws: WebSocket, pred: (m: any) => boolean, ms = 5000): Promise<any> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting message')), ms);
    const h = (ev: any) => {
      const m = JSON.parse(String(ev.data));
      if (pred(m)) { clearTimeout(t); ws.removeEventListener('message', h); res(m); }
    };
    ws.addEventListener('message', h);
  });
}

const PORT = 17451;

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-m3-'));

  // --- (a) TLS cert + WSS handshake + cert_fp match ---------------------------
  console.log('(a) TLS: cert self-signed + cert_fp TOFU + WSS handshake');
  {
    const mat = ensureCert(tmp, 'on');
    ok(!!mat && mat.certFp.startsWith('sha256:') && mat.certFp.length === 7 + 64,
      `cert_fp format spec §5.1 (${mat?.certFp.slice(0, 20)}...)`);
    ok(mat?.certFp === certFpOf(fs.readFileSync(mat!.certPath, 'utf8')), 'cert_fp = SHA-256 dari DER cert on disk');
    const stat = fs.statSync(mat!.keyPath);
    ok((stat.mode & 0o777) === 0o600, 'key.pem mode 0600');
    const again = ensureCert(tmp, 'on');
    ok(again!.certFp === mat!.certFp, 're-gen idempotent (cert lama dipakai ulang)');
    ok(ensureCert(tmp, 'off') === null, 'POCKET_TLS=off → TLS dimatikan meski cert ada');

    // WSS: https server + ws attach, client connects with rejectUnauthorized:false
    const httpsSrv = https.createServer({ cert: mat!.cert, key: mat!.key });
    await new Promise<void>((res) => httpsSrv.listen(0, '127.0.0.1', res));
    const tlsPort = (httpsSrv.address() as { port: number }).port;
    openDb(':memory:');
    setDbApi(dbmod);
    const srv = startServer({ server: httpsSrv, workspace: tmp, certFp: mat!.certFp });

    // cert_fp the client actually sees on the wire:
    const fpOnWire: string = await new Promise((res, rej) => {
      const s = tlsMod.connect({ host: '127.0.0.1', port: tlsPort, rejectUnauthorized: false }, () => {
        const fp = 'sha256:' + createHash('sha256').update(s.getPeerCertificate().raw).digest('hex');
        s.destroy();
        res(fp);
      });
      s.on('error', rej);
    });
    ok(fpOnWire === mat!.certFp, `cert_fp client == pairing payload (TOFU pin match)`);
    // client MUST reject the self-signed CA by default:
    const rejected = await connect(`wss://127.0.0.1:${tlsPort}/ws`, {}).then(() => false, () => true);
    ok(rejected, 'client default menolak self-signed CA (rejectUnauthorized default)');

    const ws = await connect(`wss://127.0.0.1:${tlsPort}/ws`, { rejectUnauthorized: false });
    sendMsg(ws, { type: 'auth', token: issuePairingToken(60_000).token });
    const aok = await waitMsg(ws, (x) => x.type === 'auth.ok');
    ok(aok.certFp === mat!.certFp, 'auth.ok carries certFp (client TOFU display)');
    const ch = await waitMsg(ws, (x) => x.type === 'auth.challenge');
    const fpHex = mat!.certFp.replace(/^sha256:/, '');
    const mac = createHmac('sha256', fpHex).update(String(ch.nonce)).digest('hex');
    ok(ch.mac === mac, 'auth.challenge mac == HMAC-SHA256(fp-hex, nonce) — client can verify');
    ws.close();
    await srv.close();
    await new Promise<void>((res) => httpsSrv.close(() => res()));
  }

  // --- (b) pairing payload shape ----------------------------------------------
  console.log('(b) Pairing payload spec §5.1');
  {
    openDb(':memory:');
    const mat = ensureCert(tmp, 'on');
    const p = buildPairingPayload({ token: 'hbk_abc', expiresAt: 1799000000, tls: mat, port: 7443 });
    ok(p.v === 1 && p.token === 'hbk_abc' && p.expires === 1799000000, 'v/token/expires sesuai §5.1');
    ok(String(p.host).startsWith('wss://') && String(p.host).endsWith(':7443') && p.mode === 'direct' && p.cert_fp === mat!.certFp, 'direct mode: wss host + mode + cert_fp');
    const plain = buildPairingPayload({ token: 'hbk_abc', expiresAt: 1, tls: null, port: 7443 });
    ok(plain.host === 'ws://127.0.0.1:7443' && plain.mode === 'tailscale' && !('cert_fp' in plain),
      'plain mode: ws:// + tanpa cert_fp (M1 kompatibel)'); // plain selalu loopback default
    const cf = buildPairingPayload({ token: 'hbk_abc', expiresAt: 1, tls: mat, port: 443, host: 'pocket.example.com' });
    ok(cf.host === 'pocket.example.com', 'POCKET_PUBLIC_HOST override (cloudflare/tailscale)');
  }

  // --- (c) push notification sanitization + offline-only delivery --------------
  console.log('(c) Push: payload disanitasi + subscribe + hanya saat offline');
  {
    const dbh = openDb(':memory:');
    setDbApi(dbmod);
    initNotify(dbh);
    ok(!!vapidPublicKey(), 'VAPID keys generated & persisted');
    const sent: Array<{ sub: PushSubscription; payload: any }> = [];
    setPushSender((sub, payload) => { sent.push({ sub, payload: JSON.parse(JSON.stringify(payload)) }); });

    const SECRET_PROMPT = 'RAHASIA-API-KEY-XYZ prompt rahasia';
    await notifyDevice('dev-none', 'turn.end', 'sess-1');
    ok(sent.length === 0, 'device tanpa subscription → tidak ada push');

    addSubscription('dev-1', { endpoint: 'https://push.mock/ep1', p256dh: 'k', auth: 'a' });
    await notifyDevice('dev-1', 'turn.end', 'sess-42');
    ok(sent.length === 1, 'turn.end → 1 push ke device offline');
    const payload = sent[0].payload;
    ok(payload.title === 'Turn selesai / Turn finished', `title fixed: "${payload.title}"`);
    ok(payload.body === 'sess-42' && payload.sessionId === 'sess-42', 'body cuma sessionId');
    const flat = JSON.stringify(payload);
    ok(!flat.includes('RAHASIA') && !flat.toLowerCase().includes('prompt'), 'TIDAK ada konten prompt/hasil di payload (§6)');
    ok(Object.keys(payload).every((k) => ['title', 'body', 'sessionId'].includes(k)), `payload keys minimal: ${Object.keys(payload)}`);

    await notifyDevice('dev-1', 'approval.requested', 'sess-42');
    ok(sent[1].payload.title === 'Approval dibutuhkan / Approval needed', 'approval.requested title');
    ok(process.env.POCKET_NTFY_URL === undefined, 'ntfy default off');

    // WS subscribe flow over a real server
    const srv = startServer({ port: PORT, bind: '127.0.0.1', workspace: tmp });
    const ws = await connect(`ws://127.0.0.1:${PORT}/ws`);
    sendMsg(ws, { type: 'auth', token: issuePairingToken(60_000).token });
    await waitMsg(ws, (x) => x.type === 'auth.ok');
    sendMsg(ws, { type: 'push.subscribe', subscription: { endpoint: 'https://push.mock/ep2', keys: { p256dh: 'k2', auth: 'a2' } } });
    ok((await waitMsg(ws, (x) => x.type === 'push.subscribed')).endpoint === 'https://push.mock/ep2', 'push.subscribe via WS');
    const row = _db().prepare("SELECT COUNT(*) c FROM push_subs WHERE endpoint='https://push.mock/ep2'").get() as { c: number };
    ok(row.c === 1, 'subscription tersimpan per device');
    sendMsg(ws, { type: 'push.unsubscribe', endpoint: 'https://push.mock/ep2' });
    await waitMsg(ws, (x) => x.type === 'push.unsubscribed');
    const row2 = _db().prepare("SELECT COUNT(*) c FROM push_subs WHERE endpoint='https://push.mock/ep2'").get() as { c: number };
    ok(row2.c === 0, 'push.unsubscribe menghapus');
    ws.close();
    await srv.close();
    setPushSender(null);
  }

  // --- (d) background job: disconnect mid-turn, turn tetap selesai + history ---
  console.log('(d) Device disconnect mid-turn → turn tetap selesai + history tersimpan (§7.6)');
  {
    openDb(':memory:');
    setDbApi(dbmod);
    // slow mock model: stream first delta, then wait so we can disconnect mid-turn
    const slowModel = new MockLanguageModelV2({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          async start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: 't1' });
            c.enqueue({ type: 'text-delta', id: 't1', delta: 'kerja' });
            await new Promise((r) => setTimeout(r, 700)); // window untuk disconnect
            c.enqueue({ type: 'text-delta', id: 't1', delta: ' selesai' });
            c.enqueue({ type: 'text-end', id: 't1' });
            c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
            c.close();
          },
        }) as never,
      }),
    });
    const srv = startServer({ port: PORT + 1, bind: '127.0.0.1', model: slowModel as never, workspace: tmp });
    const ws = await connect(`ws://127.0.0.1:${PORT + 1}/ws`);
    sendMsg(ws, { type: 'auth', token: issuePairingToken(60_000).token });
    await waitMsg(ws, (x) => x.type === 'auth.ok');
    sendMsg(ws, { type: 'session.start' });
    const sm = await waitMsg(ws, (x) => x.type === 'session.started');
    sendMsg(ws, { type: 'turn.request', turnId: 'turn-disc', prompt: 'RAHASIA kerjakan sesuatu' });
    await waitMsg(ws, (x) => x.type === 'turn.delta'); // mid-turn sekarang
    ws.close(); // HP mendadak offline
    await new Promise((r) => setTimeout(r, 1500)); // beri waktu turn selesai server-side
    const hist = listHistory(sm.sessionId);
    ok(hist.some((h) => h.role === 'user'), 'history user tersimpan');
    ok(hist.some((h) => h.role === 'assistant' && h.content === 'kerja selesai'), `history assistant tersimpan: "${hist.find((h) => h.role === 'assistant')?.content}"`);
    ok(listEvents(sm.sessionId).some((e) => e.type === 'turn.end'), 'trace turn.end tercatat walau device offline');
    const raw = _db().prepare('SELECT content FROM session_history').all() as { content: string }[];
    ok(raw.length >= 2 && raw.every((r) => r.content.startsWith('enc1:')), 'at-rest: history TERSIMPAN TERENKRIPSI (AES-256-GCM, bukan plaintext)');
    ok(!raw.some((r) => r.content.includes('RAHASIA')), 'at-rest: plaintext prompt tidak ada di DB');
    await srv.close();
  }

  closeDb();
  console.log(`\nm3: ${passed} ok, ${failed} fail`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
