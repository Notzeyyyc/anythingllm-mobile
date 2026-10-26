/**
 * AnythingPocket sidecar — M2a Full mode tests (real WS over loopback).
 * Run: node --experimental-strip-types test/full.test.ts — exit 0 = green.
 * Plain asserts, no framework, mock harness runtime (no real LLM here — the
 * real-Pi smoke runs separately via scripts/smoke-full.ts).
 *
 * (a) deterministic router: pin > tool cues > chat heuristics, one-sentence reasons
 * (b) HarnessRuntime contract over WS (fake runtime): route.decided traced,
 *     event mapping, approval gate grant → tool executed
 * (c) interrupt mid-run: turn.interrupt → ack + turn.end ok:false reason interrupted
 * (d) secrets proxy: injects Authorization upstream, strips client creds,
 *     agent-facing config never contains the real key
 * (e) session history serialization: appendHistory/listHistory roundtrip
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { openDb, closeDb, listEvents, appendHistory, listHistory, createSession } from '../src/db.ts';
import { issuePairingToken } from '../src/auth.ts';
import { startServer, setDbApi } from '../src/ws.ts';
import { routeTurn } from '../src/router.ts';
import { startSecretsProxy } from '../src/secrets-proxy.ts';
import { PiRuntime } from '../src/full/pi-runtime.ts';
import type { HarnessRuntime, RunTurnInput, RunTurnResult } from '../src/full/HarnessRuntime.ts';
import * as dbmod from '../src/db.ts';

let passed = 0, failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ok - ${label}`); }
  else { failed++; console.error(`  FAIL - ${label}`); }
}

// --- tiny WS client (same pattern as ws-runtime.test.ts) ---------------------
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
async function waitCollected(msgs: any[], pred: (m: any) => boolean, ms = 5000): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const found = msgs.find(pred);
    if (found) return found;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting collected message');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const PORT = 17449;
const URL = `ws://127.0.0.1:${PORT}/ws`;
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

// --- fake HarnessRuntime: contract-compatible with lite ----------------------
class FakeRuntime implements HarnessRuntime {
  readonly name = 'fake';
  lastInput: RunTurnInput | null = null;
  private readonly behavior: (input: RunTurnInput) => Promise<RunTurnResult>;
  constructor(behavior: (input: RunTurnInput) => Promise<RunTurnResult>) { this.behavior = behavior; }
  runTurn(input: RunTurnInput): Promise<RunTurnResult> { this.lastInput = input; return this.behavior(input); }
  interrupt(turnId: string): void { /* tests abort via signal */ void turnId; }
}

async function main(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-full-'));
  openDb(':memory:');
  setDbApi(dbmod);

  // --- (a) deterministic router ---------------------------------------------
  console.log('(a) router deterministik');
  {
    delete process.env.POCKET_FORCE_RUNTIME;
    const pinned = routeTurn('halo', { forceRuntime: 'full' });
    ok(pinned.runtime === 'full' && pinned.reason.includes('user pin'), `pin full menang (${pinned.reason})`);
    const pinnedLite = routeTurn('buat file x', { forceRuntime: 'lite' });
    ok(pinnedLite.runtime === 'lite', `pin lite menang (${pinnedLite.reason})`);
    const toolCue = routeTurn('tulis file laporan.txt berisi ringkasan');
    ok(toolCue.runtime === 'full' && toolCue.reason.length > 0, `tool cue → full (${toolCue.reason})`);
    const chat = routeTurn('halo apa kabar?');
    ok(chat.runtime === 'lite', `chat pendek → lite (${chat.reason})`);
    const long = routeTurn('x'.repeat(200));
    ok(long.runtime === 'full' && long.reason.includes('capability'), `panjang ambigu → full (${long.reason})`);
    ok(!/\n/.test(toolCue.reason), 'alasan satu kalimat');
  }

  // --- (b) HarnessRuntime contract over WS (fake runtime) --------------------
  console.log('(b) contract test dgn fake runtime over WS');
  {
    const fake = new FakeRuntime(async (input) => {
      input.emit('llm.call.start', { model: 'fake/model' });
      input.emit('tool.call.start', { tool: 'write_file', argsHash: 'abc123' });
      const ap = await input.approvalHandler({ tool: 'write_file', path: 'b.txt', content: 'isi b', diff: '(file baru)' });
      input.emit(ap.approved ? 'approval.granted' : 'approval.rejected', { approvalId: ap.approvalId });
      if (ap.approved) fs.writeFileSync(path.join(input.workspace, 'b.txt'), 'isi b');
      input.emit('tool.call.end', { tool: 'write_file', ok: ap.approved, durationMs: 3 });
      input.emit('llm.call.end', { model: 'fake/model', durationMs: 12 });
      input.onDelta?.('halo ');
      input.onDelta?.('dunia');
      return { ok: true, text: 'halo dunia' };
    });
    const srv = startServer({ port: PORT, bind: '127.0.0.1', workspace, approvalTtlMs: 2000, fullRuntime: fake });
    const { ws, sessionId } = await client();
    const msgs: any[] = [];
    collect(ws, msgs);
    sendMsg(ws, { type: 'turn.request', turnId: 'full-b', prompt: 'tulis file b.txt' });
    const req = await waitCollected(msgs, (x) => x.type === 'approval.request');
    ok(req.turnId === 'full-b' && req.tool === 'write_file', 'approval.request dari full runtime (kontrak sama dgn lite)');
    sendMsg(ws, { type: 'approval.response', approvalId: req.approvalId, decision: 'grant' });
    const end = await waitCollected(msgs, (x) => x.type === 'turn.end' && x.turnId === 'full-b');
    ok(end.ok === true && end.text === 'halo dunia', `turn.end ok text "${end.text}"`);
    const deltas = msgs.filter((m) => m.type === 'turn.delta' && m.turnId === 'full-b').map((m) => m.delta);
    ok(deltas.join('') === 'halo dunia', `turn.delta stream (${deltas.length} chunk)`);
    ok(fs.existsSync(path.join(workspace, 'b.txt')), 'file b.txt terulis setelah grant');
    const events = listEvents(sessionId);
    const route = events.find((e) => e.type === 'route.decided');
    ok(!!route && route.payload.runtime === 'full' && typeof route.payload.reason === 'string',
      `route.decided di trace (${route?.payload.runtime}: ${route?.payload.reason})`);
    ok(!!route && route!.turnId === 'full-b', 'route.decided bawa turnId');
    const types: string[] = events.filter((e) => e.turnId === 'full-b').map((e) => e.type);
    for (const t of ['turn.start', 'llm.call.start', 'tool.call.start', 'approval.requested', 'approval.granted', 'tool.call.end', 'llm.call.end', 'turn.end']) {
      ok(types.includes(t) === true, `trace ada ${t}`);
    }
    ok(fake.lastInput!.signal instanceof AbortSignal, 'abort signal diteruskan ke runtime');
    // history serialization
    const hist = listHistory(sessionId);
    ok(hist.length === 2 && hist[0].role === 'user' && hist[1].role === 'assistant', 'history user+assistant tersimpan');
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    await srv.close();
  }

  // --- (c) interrupt mid-run -------------------------------------------------
  console.log('(c) interrupt mid-run → turn.end ok:false reason interrupted');
  {
    let aborted = false;
    const slow = new FakeRuntime(async (input) => {
      await new Promise<void>((res) => {
        const t = setTimeout(res, 30_000);
        input.signal!.addEventListener('abort', () => { aborted = true; clearTimeout(t); res(); });
      });
      return { ok: false, text: null, reason: 'interrupted' };
    });
    const srv = startServer({ port: PORT, bind: '127.0.0.1', workspace, fullRuntime: slow });
    const { ws, sessionId } = await client();
    const msgsC: any[] = [];
    collect(ws, msgsC);
    sendMsg(ws, { type: 'turn.request', turnId: 'full-c', prompt: 'jalankan task berat lama dengan bash' });
    await new Promise((r) => setTimeout(r, 100)); // let the turn start
    sendMsg(ws, { type: 'turn.interrupt', turnId: 'full-c' });
    const ack = await waitCollected(msgsC, (x) => x.type === 'turn.interrupt.ack');
    ok(ack.interrupted === true, 'turn.interrupt.ack interrupted:true');
    const end = await waitCollected(msgsC, (x) => x.type === 'turn.end' && x.turnId === 'full-c');
    ok(end.ok === false && end.error === 'interrupted', `turn.end ok:false error "${end.error}"`);
    ok(aborted, 'abort signal terkirim ke runtime');
    const traceEnd = listEvents(sessionId).filter((e) => e.turnId === 'full-c' && e.type === 'turn.end').pop();
    ok(!!traceEnd && traceEnd!.payload.reason === 'interrupted', 'turn.end trace bawa reason interrupted');
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    await srv.close();
  }

  // --- (d) secrets proxy ------------------------------------------------------
  console.log('(d) secrets proxy: inject Authorization, strip kredensial client');
  {
    const REAL_KEY = 'sk-test-real-key-123';
    let seenAuth: string | null = null;
    let seenClientAuth: string | null = null;
    const upstream = http.createServer((req, res) => {
      seenAuth = req.headers.authorization ?? null;
      seenClientAuth = req.headers['x-client-marker'] as string ?? null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((res) => upstream.listen(0, '127.0.0.1', res));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startSecretsProxy({ upstreamBase: `http://127.0.0.1:${upstreamPort}/v1`, key: REAL_KEY });
    const res = await fetch(`${proxy.url}/chat/completions`, {
      method: 'POST',
      headers: { 'authorization': 'Bearer attacker-key', 'x-client-marker': 'yes', 'content-type': 'application/json' },
      body: '{"model":"m"}',
    });
    ok(res.status === 200, 'proxy → upstream 200');
    ok(seenAuth === `Bearer ${REAL_KEY}`, 'upstream menerima Bearer KEY ASLI (injected)');
    ok(seenClientAuth === 'yes', 'header non-kredensial diteruskan');
    // agent-facing config: placeholder only
    const rt = new PiRuntime({ baseUrl: proxy.url, apiKey: 'via-secrets-proxy', model: 'm/x' });
    ok((rt as unknown as { opts: { apiKey: string } }).opts.apiKey === 'via-secrets-proxy', 'PiRuntime lihat placeholder, bukan key asli');
    ok(proxy.url.startsWith('http://127.0.0.1:'), `proxy bind 127.0.0.1 port acak (${proxy.url})`);
    proxy.close(); upstream.close();
    void rt;
  }

  // --- (e) session history roundtrip ------------------------------------------
  console.log('(e) session history serialization');
  {
    const sid = createSession(null); // FK: history references sessions
    appendHistory(sid, 't1', 'user', 'prompt pertama');
    appendHistory(sid, 't1', 'assistant', 'jawaban pertama');
    const hist = listHistory(sid);
    ok(hist.length === 2 && hist[0].content === 'prompt pertama' && hist[1].role === 'assistant', 'appendHistory/listHistory roundtrip');
  }

  closeDb();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
