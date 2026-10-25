/**
 * AnythingPocket sidecar — Lite mode CLI (spec §4.1, M1).
 * Usage: npm run lite -- "prompt" [--yes] [--model M] [--base-url U] [--api-key-file F]
 * Env: POCKET_MODEL / POCKET_BASE_URL / POCKET_API_KEY_FILE / POCKET_WORKSPACE.
 * API key is read from file at runtime — never printed, logged, or traced.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { openDb, closeDb, createSession, insertEvent, DATA_DIR } from '../db.ts';
import { runLiteAgent } from './agent.ts';
import { resolveInWorkspace } from './tools.ts';
import type { ApprovalHandler } from '../runtime.ts';
import type { EventType } from '../schema.ts';

function parseArgs(argv: string[]) {
  const opts: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') opts.yes = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i] ?? '';
    else rest.push(a);
  }
  return { opts, rest };
}

/** Stdin approval handler (CLI flavor of the ApprovalHandler interface — WS flavor lives in runtime.ts). */
export function createStdinApprovalHandler(
  emit: (type: EventType, payload: Record<string, unknown>) => void,
  opts: { autoYes?: boolean; ttlMs?: number } = {},
): ApprovalHandler {
  const ttlMs = opts.ttlMs ?? 30_000;
  return async (req) => {
    const approvalId = crypto.randomUUID();
    emit('approval.requested', { approvalId, tool: req.tool, command: req.path, diff: req.diff ?? undefined, ttlMs });
    if (opts.autoYes) return { approved: true, approvalId };
    console.log(`\n── approval diminta: ${req.tool} → ${req.path}`);
    console.log(req.diff ?? req.content);
    console.log('Izinkan? [y/N] (30s timeout = tidak)');
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    const answer = await new Promise<string | null>((res) => {
      const t = setTimeout(() => { rl.close(); res(null); }, ttlMs);
      rl.once('line', (l) => { clearTimeout(t); rl.close(); res(l); });
      rl.once('close', () => { clearTimeout(t); res(null); });
    });
    return { approved: answer?.trim().toLowerCase() === 'y', approvalId };
  };
}

export async function main(argv: string[]): Promise<number> {
  const { opts, rest } = parseArgs(argv);
  if (rest[0] === 'run') rest.shift(); // `anythingpocket run "prompt"`
  const prompt = rest.join(' ');
  if (!prompt) {
    console.error('Usage: anythingpocket run "prompt" [--yes] [--model M] [--base-url U] [--api-key-file F]');
    return 2;
  }

  const model = String(opts.model ?? process.env.POCKET_MODEL ?? 'ngd/ngodeai/gemini-3.8-flash');
  const baseUrl = String(opts['base-url'] ?? process.env.POCKET_BASE_URL ?? 'http://127.0.0.1:20128/v1');
  const keyFile = String(opts['api-key-file'] ?? process.env.POCKET_API_KEY_FILE ?? '/root/.secrets/9router_local_key.txt');
  const dataDir = process.env.POCKET_DATA_DIR ?? DATA_DIR;
  const workspace = path.resolve(process.env.POCKET_WORKSPACE ?? path.resolve(import.meta.dirname, '../../workspace'));
  fs.mkdirSync(workspace, { recursive: true });

  // Key read at runtime from file; never stored/printed.
  const apiKey = fs.readFileSync(keyFile, 'utf8').trim();

  const db = openDb(path.resolve(dataDir, 'sidecar.db'));
  const sessionId = createSession(null);
  const turnId = crypto.randomUUID();
  const emit = (type: Parameters<typeof insertEvent>[2], payload: Record<string, unknown>) => {
    insertEvent(sessionId, turnId, type, payload);
  };

  emit('turn.start', { prompt });
  const t0 = Date.now();
  try {
    const provider = createOpenAICompatible({ name: 'pocket', baseURL: baseUrl, apiKey });
    const result = await runLiteAgent({
      model: provider(model),
      prompt, sessionId, turnId, workspace,
      approvalHandler: createStdinApprovalHandler(emit, { autoYes: opts.yes === true }),
      emit,
    });
    process.stdout.write(result.text + '\n');
    const evs = `turn.end — ${result.steps} step, ${result.toolCalls} tool call, ${Date.now() - t0}ms`;
    console.log(`[${evs}] session=${sessionId}`);
    return 0;
  } catch (e) {
    // Provider failures arrive as plain objects (e.g. {message,type,code}); render them readably.
    const msg = e instanceof Error
      ? e.message
      : typeof e === 'object' && e !== null && 'message' in e
        ? String((e as { message: unknown }).message)
        : JSON.stringify(e);
    console.error(`Lite run gagal: ${msg}`);
    return 1;
  } finally {
    closeDb();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
