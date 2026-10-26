/**
 * AnythingPocket sidecar — secrets proxy (spec §6).
 * Local HTTP proxy (127.0.0.1, random port) that holds the provider API key
 * in the parent server process and injects `Authorization` on the way
 * upstream. The agent/Pi runtime only ever sees POCKET_PROXY_URL + a dummy
 * key — the real key never enters the child/agent env, config, or logs.
 *
 * ponytail: limitation (documented in docs/m2a-full-runtime.md) — the runtime
 * is a host-process on the SAME machine, so this prevents key leakage via
 * child env/config/logs, NOT full process isolation. That isolation is the
 * sandbox's job (container/landlock, M2a sandbox workstream).
 */
import * as http from 'node:http';
import * as fs from 'node:fs';

export interface SecretsProxy {
  /** http://127.0.0.1:<random>/v1 — give THIS to the agent runtime. */
  url: string;
  port: number;
  close(): void;
}

/**
 * Start the proxy. upstreamBase: real provider base URL (e.g.
 * http://127.0.0.1:20128/v1). key: API key, read server-side (parent) —
 * never passed through the agent. authStyle: 'bearer' | 'x-api-key'.
 */
export async function startSecretsProxy(opts: {
  upstreamBase: string;
  key: string;
  authStyle?: 'bearer' | 'x-api-key';
}): Promise<SecretsProxy> {
  const upstream = new URL(opts.upstreamBase);
  const authStyle = opts.authStyle ?? 'bearer';
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const target = new URL(upstream);
      target.pathname = (upstream.pathname.replace(/\/$/, '') + req.url).replace('//', '/');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === 'host' || k === 'authorization' || k === 'x-api-key') continue; // strip client creds
        headers[k] = String(v);
      }
      // Inject the real key HERE, server-side. Agent never sees it.
      if (authStyle === 'bearer') headers['authorization'] = `Bearer ${opts.key}`;
      else headers['x-api-key'] = opts.key;

      const preq = http.request(target, { method: req.method, headers }, (pres) => {
        res.writeHead(pres.statusCode ?? 502, pres.headers);
        pres.pipe(res);
      });
      preq.on('error', (e) => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `secrets proxy upstream error: ${e.message}` } }));
      });
      preq.end(Buffer.concat(chunks));
    });
  });
  await new Promise<void>((res, rej) => {
    server.once('listening', res);
    server.once('error', rej);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('secrets proxy: no port');
  return {
    url: `http://127.0.0.1:${address.port}${upstream.pathname}`,
    port: address.port,
    close: () => server.close(),
  };
}

/** Convenience: read key from file in the PARENT process (never in the agent). */
export function readKeyFromFile(file: string): string {
  return fs.readFileSync(file, 'utf8').trim();
}
