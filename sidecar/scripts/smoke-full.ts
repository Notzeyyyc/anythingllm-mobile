/**
 * AnythingPocket sidecar — M2a real smoke (ONE run): server + router → Full
 * (PiRuntime host-process, real 9router model via secrets proxy) over real WS.
 * Evidence printed: route.decided, tool calls, approval grant, written file,
 * trace events in SQLite. Run: node --experimental-strip-types scripts/smoke-full.ts
 * Env: POCKET_BASE_URL / POCKET_API_KEY_FILE / POCKET_MODEL (defaults like CLI).
 * ponytail: throwaway evidence script — not part of npm test (needs real key).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, closeDb, listEvents } from '../src/db.ts';
import { issuePairingToken } from '../src/auth.ts';
import { startServer, setDbApi } from '../src/ws.ts';
import { PiRuntime } from '../src/full/pi-runtime.ts';
import { startSecretsProxy, readKeyFromFile } from '../src/secrets-proxy.ts';
import { fullModelConfig } from '../src/router.ts';
import * as dbmod from '../src/db.ts';

const PORT = 17455;
const URL = `ws://127.0.0.1:${PORT}/ws`;
function connect(url: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('connect failed'));
  });
}
function waitMsg(ws: WebSocket, pred: (m: any) => boolean, ms = 120_000): Promise<any> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting message')), ms);
    const h = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data));
      console.log('<<', JSON.stringify(m).slice(0, 300));
      if (pred(m)) { clearTimeout(t); ws.removeEventListener('message', h); res(m); }
    };
    ws.addEventListener('message', h);
  });
}

async function main(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-smoke-'));
  console.log('WORKSPACE:', workspace);
  const { baseUrl, model } = fullModelConfig();
  const proxy = await startSecretsProxy({
    upstreamBase: baseUrl,
    key: readKeyFromFile(process.env.POCKET_API_KEY_FILE ?? '/root/.secrets/9router_local_key.txt'),
    socketPath: path.join(os.tmpdir(), `pocket-smoke-proxy-${Date.now()}.sock`),
  });
  console.log('SECRETS PROXY:', proxy.url, 'UNIX:', proxy.socketPath, '(key stays parent-side; agent sees placeholder only)');
  const fullRuntime = new PiRuntime({ baseUrl: proxy.url, apiKey: 'via-secrets-proxy', model, sandboxMode: process.env.POCKET_SANDBOX ?? 'auto', proxySocketPath: proxy.socketPath });

  openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-smoke-db-')), 'smoke.db'));
  setDbApi(dbmod);
  const srv = startServer({ port: PORT, bind: '127.0.0.1', workspace, fullRuntime, approvalTtlMs: 60_000 });

  const ws = await connect(URL);
  send({ type: 'auth', token: issuePairingToken(60_000).token });
  await waitMsg(ws, (m) => m.type === 'auth.ok');
  send({ type: 'session.start' });
  const started = await waitMsg(ws, (m) => m.type === 'session.started');

  const turnId = 'smoke-full-1';
  send({ type: 'turn.request', turnId, prompt: 'Jalankan bash `ls` di workspace (tool bash), lalu gunakan tool write_file untuk membuat file catatan.txt berisi satu kalimat: "Smoke sandbox bash berjalan." Jawab singkat.' });

  // approvals can arrive repeatedly (bash, write_file) — grant each, then wait end
  const end: any = await (async () => {
    for (;;) {
      const req = await waitMsg(ws, (m) => m.type === 'approval.request' || (m.type === 'turn.end' && m.turnId === turnId));
      if (req.type === 'turn.end') return req;
      console.log('>> approval GRANT', req.approvalId, req.tool);
      send({ type: 'approval.response', approvalId: req.approvalId, decision: 'grant' });
    }
  })();

  const file = path.join(workspace, 'catatan.txt');
  console.log('--- EVIDENCE ---');
  console.log('turn.end:', JSON.stringify(end).slice(0, 300));
  console.log('file written:', fs.existsSync(file), '→', fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '(missing)');
  const events = listEvents(started.sessionId);
  const byType: Record<string, number> = {};
  for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
  console.log('TRACE COUNTS:', JSON.stringify(byType));
  const route = events.find((e) => e.type === 'route.decided');
  console.log('route.decided:', JSON.stringify(route?.payload));
  const sbx = events.find((e) => e.type === 'sandbox.decided');
  console.log('sandbox.decided:', JSON.stringify(sbx?.payload));
  console.log('tool calls:', events.filter((e) => e.type === 'tool.call.start').map((e) => e.payload.tool).join(','));
  const leak = JSON.stringify(events.map((e) => e.payload)).includes(readKeyFromFile(process.env.POCKET_API_KEY_FILE ?? '/root/.secrets/9router_local_key.txt'));
  console.log('key leaked into trace:', leak);
  const okSmoke = end.ok === true && fs.existsSync(file) && byType['tool.call.start'] > 0 && !!route && !!sbx && !leak;
  console.log(okSmoke ? 'SMOKE PASS' : 'SMOKE FAIL');
  ws.close();
  await srv.close();
  proxy.close();
  closeDb();
  process.exit(okSmoke ? 0 : 1);

  function send(msg: object): void { ws.send(JSON.stringify(msg)); }
}

main().catch((e) => { console.error(e); process.exit(1); });
