/**
 * AnythingPocket sidecar — WS protocol v1 runtime e2e (real WS over loopback).
 * Run: npm run test:runtime — exit 0 = green. Plain asserts, no framework.
 * Mock model (no real LLM) + DB :memory:, same pattern as lite.test.ts.
 *
 * (a) grant:  turn.request → approval.request → approval.response grant → turn.end ok → file written
 * (b) reject: approval.response reject → turn.end ok:true (text explains) → file NOT written
 * (c) TTL:    no response → server auto-REJECT after ttlMs (expired) → file NOT written
 * (d) turn.request while a turn is active → error 'turn in progress'
 * (e) approval.response with a foreign/unknown approvalId → ignored; duplicate response idempotent
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockLanguageModelV2, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { openDb, closeDb, listEvents, getApproval, _db } from '../src/db.ts';
import { issuePairingToken } from '../src/auth.ts';
import { startServer, setDbApi } from '../src/ws.ts';
import * as dbmod from '../src/db.ts';

let passed = 0, failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ok - ${label}`); }
  else { failed++; console.error(`  FAIL - ${label}`); }
}

// --- mock model: switchable per scenario, tool-call step + text step ---------
function stream(parts: unknown[]) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] }, ...parts,
    ] as LanguageModelV2StreamPart[]),
  };
}
let currentModel: any = null;
const switchableModel = new MockLanguageModelV2({
  doStream: async (o: never) => currentModel!.doStream(o) as never,
});
function writeThenSay(file: string, content: string, say: string) {
  let step = 0;
  return new MockLanguageModelV2({
    doStream: async () => {
      const parts: unknown[] = step++ === 0
        ? [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'write_file', input: JSON.stringify({ path: file, content }) },
            { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
          ]
        : [
            { type: 'text-start', id: 't2' },
            { type: 'text-delta', id: 't2', delta: say.slice(0, Math.ceil(say.length / 2)) },
            { type: 'text-delta', id: 't2', delta: say.slice(Math.ceil(say.length / 2)) },
            { type: 'text-end', id: 't2' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } },
          ];
      return stream(parts);
    },
  });
}

// --- tiny WS client ----------------------------------------------------------
function connect(url: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('connect failed'));
  });
}
function sendMsg(ws: WebSocket, msg: object): void { ws.send(JSON.stringify(msg)); }
function waitMsg(ws: WebSocket, pred: (m: any) => boolean, ms = 5000): Promise<any> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { ws.removeEventListener('message', h); rej(new Error('timeout waiting message')); }, ms);
    const h = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data));
      if (pred(m)) { clearTimeout(t); ws.removeEventListener('message', h); res(m); }
    };
    ws.addEventListener('message', h);
  });
}
function collect(ws: WebSocket, sink: any[]): void {
  ws.addEventListener('message', (ev) => sink.push(JSON.parse(String(ev.data))));
}

/** Poll a collected sink for a matching message (handles messages already received). */
async function waitCollected(msgs: any[], pred: (m: any) => boolean, ms = 5000): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const found = msgs.find(pred);
    if (found) return found;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting collected message');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const PORT = 17445;
const URL = `ws://127.0.0.1:${PORT}/ws`;

/** Authed + session started client. Returns {ws, sessionId}. */
async function client(): Promise<{ ws: WebSocket; sessionId: string }> {
  const ws = await connect(URL);
  const authed = waitMsg(ws, (x) => x.type === 'auth.ok' || x.type === 'auth.deny');
  sendMsg(ws, { type: 'auth', token: issuePairingToken(60_000).token });
  const m = await authed;
  if (m.type !== 'auth.ok') throw new Error('auth failed: ' + m.reason);
  sendMsg(ws, { type: 'session.start' });
  const sm = await waitMsg(ws, (x) => x.type === 'session.started');
  return { ws, sessionId: sm.sessionId };
}

async function main(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ws-'));
  openDb(':memory:');
  setDbApi(dbmod);
  const srv = startServer({ port: PORT, bind: '127.0.0.1', model: switchableModel as never, workspace, approvalTtlMs: 300 });

  // --- (a) grant → file written, deltas streamed, trace consistent
  console.log('(a) turn.request → approval grant → turn.end ok, file terulis');
  {
    currentModel = writeThenSay('a.txt', 'isi a', 'selesai menulis a');
    const { ws, sessionId } = await client();
    const msgs: any[] = [];
    collect(ws, msgs);
    sendMsg(ws, { type: 'turn.request', turnId: 'turn-a', prompt: 'tulis file a.txt' });
    const req = await waitMsg(ws, (x) => x.type === 'approval.request');
    ok(req.turnId === 'turn-a', 'approval.request bawa turnId');
    ok(req.tool === 'write_file' && req.path === 'a.txt', `approval.request (${req.tool} → ${req.path})`);
    ok(typeof req.contentPreview === 'string' && req.ttlMs === 300, 'contentPreview + ttlMs ada');
    const deltas: any[] = [];
    sendMsg(ws, { type: 'approval.response', approvalId: req.approvalId, decision: 'grant' });
    const end = await waitMsg(ws, (x) => x.type === 'turn.end' && x.turnId === 'turn-a');
    for (const m of msgs) if (m.type === 'turn.delta' && m.turnId === 'turn-a') deltas.push(m.delta);
    ok(end.ok === true && end.text === 'selesai menulis a' && end.error === null, `turn.end ok, text "${end.text}"`);
    ok(deltas.join('') === 'selesai menulis a', `turn.delta stream (${deltas.length} chunk) digabung = final text`);
    const target = path.join(workspace, 'a.txt');
    ok(fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'isi a', 'file a.txt terulis');
    const types = listEvents(sessionId).map((e) => e.type);
    ok(types.includes('approval.requested') && types.includes('approval.granted') && types.includes('turn.end'),
      `trace: ${types.join(', ')}`);
    const requested = listEvents(sessionId).find((e) => e.type === 'approval.requested');
    ok(requested!.payload.approvalId === req.approvalId, 'approval.requested trace pakai approvalId asli');
    ws.close();
  }

  // --- (b) reject → file NOT written, turn.end ok:true dengan teks
  console.log('(b) approval reject → file tidak terulis, turn.end ok:true');
  {
    currentModel = writeThenSay('b.txt', 'isi b', 'penulisan b ditolak pengguna, tidak ada file yang ditulis');
    const { ws, sessionId } = await client();
    sendMsg(ws, { type: 'turn.request', turnId: 'turn-b', prompt: 'tulis file b.txt' });
    const req = await waitMsg(ws, (x) => x.type === 'approval.request');
    sendMsg(ws, { type: 'approval.response', approvalId: req.approvalId, decision: 'reject' });
    const end = await waitMsg(ws, (x) => x.type === 'turn.end' && x.turnId === 'turn-b');
    ok(end.ok === true && typeof end.text === 'string' && end.text.includes('ditolak'), `turn.end ok:true, "${end.text}"`);
    ok(!fs.existsSync(path.join(workspace, 'b.txt')), 'file b.txt TIDAK terulis');
    ok(listEvents(sessionId).some((e) => e.type === 'approval.rejected'), 'approval.rejected tercatat');
    ws.close();
  }

  // --- (c) TTL: no response → auto REJECT (expired), file NOT written
  console.log('(c) TTL 300ms tanpa jawaban → auto REJECT');
  {
    currentModel = writeThenSay('c.txt', 'isi c', 'penulisan c ditolak otomatis (kedaluwarsa)');
    const { ws, sessionId } = await client();
    const msgs: any[] = [];
    collect(ws, msgs);
    sendMsg(ws, { type: 'turn.request', turnId: 'turn-c', prompt: 'tulis file c.txt' });
    const req = await waitCollected(msgs, (x) => x.type === 'approval.request');
    const exp = await waitCollected(msgs, (x) => x.type === 'approval.expired', 5000);
    ok(exp.approvalId === req.approvalId, 'approval.expired didorong ke client');
    const end = await waitCollected(msgs, (x) => x.type === 'turn.end' && x.turnId === 'turn-c');
    ok(end.ok === true && !fs.existsSync(path.join(workspace, 'c.txt')), 'turn.end ok:true, file TIDAK terulis');
    ok(getApproval(req.approvalId)!.status === 'expired', "status DB = 'expired' (default REJECT)");
    ok(listEvents(sessionId).some((e) => e.type === 'approval.expired'), 'approval.expired tercatat di trace');
    ws.close();
  }

  // --- (d) turn.request kedua saat loop aktif → error 'turn in progress'
  console.log('(d) turn.request kedua saat aktif → error turn in progress');
  {
    currentModel = writeThenSay('d.txt', 'isi d', 'selesai d');
    const { ws } = await client();
    sendMsg(ws, { type: 'turn.request', turnId: 'turn-d1', prompt: 'tulis file d.txt' });
    const req = await waitMsg(ws, (x) => x.type === 'approval.request');
    sendMsg(ws, { type: 'turn.request', turnId: 'turn-d2', prompt: 'tulis lagi' });
    const err = await waitMsg(ws, (x) => x.type === 'error');
    ok(err.message === 'turn in progress', `error "${err.message}"`);
    sendMsg(ws, { type: 'approval.response', approvalId: req.approvalId, decision: 'grant' });
    const end = await waitMsg(ws, (x) => x.type === 'turn.end' && x.turnId === 'turn-d1');
    ok(end.ok === true && fs.existsSync(path.join(workspace, 'd.txt')), 'turn pertama selesai normal');
    // after the turn ends, a new turn must be accepted (no stuck lock)
    currentModel = writeThenSay('d2.txt', 'isi d2', 'selesai d2');
    sendMsg(ws, { type: 'turn.request', turnId: 'turn-d3', prompt: 'tulis d2' });
    const end2 = await waitMsg(ws, (x) => x.type === 'turn.end' && x.turnId === 'turn-d3');
    ok(end2.ok === true, 'turn baru diterima setelah turn sebelumnya selesai');
    ws.close();
  }

  // --- (e) foreign / unknown approvalId diabaikan; duplicate response idempotent
  console.log('(e) approval.response asing / duplikat diabaikan');
  {
    currentModel = writeThenSay('e.txt', 'isi e', 'selesai e');
    const { ws: wsA } = await client();
    const { ws: wsB } = await client();
    sendMsg(wsA, { type: 'turn.request', turnId: 'turn-e', prompt: 'tulis file e.txt' });
    const req = await waitMsg(wsA, (x) => x.type === 'approval.request');
    // foreign: B answers A's approval → must be ignored, A's approval stays pending
    sendMsg(wsB, { type: 'approval.response', approvalId: req.approvalId, decision: 'reject' });
    // unknown id: also ignored
    sendMsg(wsA, { type: 'approval.response', approvalId: 'does-not-exist', decision: 'grant' });
    // small settle window: if the foreign response had landed, a.txt would already be rejected
    await new Promise((r) => setTimeout(r, 150));
    // A grants — proves earlier responses did not consume the pending approval
    sendMsg(wsA, { type: 'approval.response', approvalId: req.approvalId, decision: 'grant' });
    sendMsg(wsA, { type: 'approval.response', approvalId: req.approvalId, decision: 'grant' }); // duplicate → ignored
    const end = await waitMsg(wsA, (x) => x.type === 'turn.end' && x.turnId === 'turn-e');
    ok(end.ok === true && fs.readFileSync(path.join(workspace, 'e.txt'), 'utf8') === 'isi e',
      'approval milik device lain diabaikan; grant dari pemilik tetap jalan');
    const rows = _db().prepare('SELECT payload FROM events').all() as { payload: string }[];
    ok(!JSON.stringify(rows).includes('hbk_') && !JSON.stringify(rows).includes('hbs_'), 'trace bebas token');
    wsA.close(); wsB.close();
  }

  await srv.close();
  closeDb();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('WS RUNTIME TEST crashed:', e); process.exit(1); });
