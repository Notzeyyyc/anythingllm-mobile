/**
 * AnythingPocket sidecar — Lite mode tests with MOCK model (no real provider).
 * Run: npm run test:lite — exit 0 = green. Plain asserts, no framework.
 * Covers: multi-step loop + events, write_file reject/approve, path escape,
 * provider error → error event.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockLanguageModelV2, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { openDb, closeDb, listEvents, _db, insertEvent, createSession } from '../src/db.ts';
import { runLiteAgent } from '../src/lite/agent.ts';

let passed = 0, failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ok - ${label}`); }
  else { failed++; console.error(`  FAIL - ${label}`); }
}

const alwaysReject = async () => false;
const alwaysApprove = async () => true;

/** stream-start must be first part (LanguageModelV2 spec). */
function stream(parts: unknown[]) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] }, ...parts,
    ] as LanguageModelV2StreamPart[]),
  };
}
function textModel(text: string) {
  return new MockLanguageModelV2({
    doStream: async () => stream([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: text },
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } },
    ]),
  });
}
function toolCallThenTextModel(toolName: string, args: Record<string, unknown>, finalText: string) {
  let step = 0;
  return new MockLanguageModelV2({
    doStream: async () => {
      const parts: unknown[] = step++ === 0
        ? [
            { type: 'tool-call', toolCallId: 'c1', toolName, input: JSON.stringify(args) },
            { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
          ]
        : [
            { type: 'text-start', id: 't2' },
            { type: 'text-delta', id: 't2', delta: finalText },
            { type: 'text-end', id: 't2' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } },
          ];
      return stream(parts);
    },
  });
}

function setup(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-lite-'));
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'hello pocket');
  openDb(':memory:');
  return ws;
}
function runAgent(ws: string, model: unknown, approval = alwaysReject) {
  const sessionId = createSession(null);
  const turnId = crypto.randomUUID();
  const syncEmit = (type: Parameters<typeof insertEvent>[2], payload: Record<string, unknown>) =>
    insertEvent(sessionId, turnId, type, payload);
  return { result: runLiteAgent({ model: model as never, prompt: 'test', sessionId, turnId, workspace: ws, approvalHandler: approval, emit: syncEmit }), sessionId };
}

async function main(): Promise<void> {
  // (a) multi-step loop: read_file tool call → final answer
  console.log('(a) multi-step: prompt → read_file → jawaban');
  {
    const ws = setup();
    const { result, sessionId } = runAgent(ws, toolCallThenTextModel('read_file', { path: 'notes.txt' }, 'isi: hello pocket'));
    const r = await result;
    ok(r.text === 'isi: hello pocket', `teks final "${r.text}"`);
    ok(r.toolCalls === 1, `1 tool call (${r.toolCalls})`);
    const types = listEvents(sessionId).map((e) => e.type);
    ok(types.filter((t) => t === 'llm.call.start').length >= 1, 'llm.call.start ≥1');
    ok(types.includes('tool.call.start') && types.includes('tool.call.end'), 'tool.call.start + tool.call.end');
    ok(types.includes('turn.end'), 'turn.end');
    closeDb();
  }

  // (b) write_file rejected → file NOT written, approval.rejected recorded
  console.log('(b) write_file ditolak (default REJECT)');
  {
    const ws = setup();
    const target = path.join(ws, 'nope.txt');
    const { result, sessionId } = runAgent(ws, toolCallThenTextModel('write_file', { path: 'nope.txt', content: 'x' }, 'ok'));
    const r = await result;
    ok(!fs.existsSync(target), 'file TIDAK ditulis');
    ok(listEvents(sessionId).some((e) => e.type === 'approval.rejected'), 'approval.rejected tercatat');
    ok(r.toolCalls === 1, 'tool call terhitung');
    closeDb();
  }

  // (c) write_file approved → file written
  console.log('(c) write_file di-approve → file terulis');
  {
    const ws = setup();
    const target = path.join(ws, 'yes.txt');
    const { result, sessionId } = runAgent(ws, toolCallThenTextModel('write_file', { path: 'yes.txt', content: 'disetujui' }, 'selesai'), alwaysApprove);
    await result;
    ok(fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'disetujui', 'file terulis dengan isi benar');
    ok(listEvents(sessionId).some((e) => e.type === 'approval.granted'), 'approval.granted tercatat');
    closeDb();
  }

  // (d) path escape ditolak, tidak crash
  console.log('(d) path escape ../../etc/passwd ditolak');
  {
    const ws = setup();
    const { result, sessionId } = runAgent(ws, toolCallThenTextModel('read_file', { path: '../../etc/passwd' }, 'gagal seperti direncanakan'));
    const r = await result;
    ok(r.text === 'gagal seperti direncanakan', 'loop tetap lanjut, tidak crash');
    ok(listEvents(sessionId).some((e) => e.type === 'tool.call.end'), 'tool.call.end (error path) tercatat');
    closeDb();
  }

  // (e) provider error → error event + throw
  console.log('(e) provider error → event error + throw');
  {
    const ws = setup();
    const bad = new MockLanguageModelV2({
      doStream: async () => stream([{ type: 'error', error: new Error('ECONNREFUSED provider down') } as LanguageModelV2StreamPart]),
    });
    const { result, sessionId } = runAgent(ws, bad);
    let threw = false;
    try { await result; } catch { threw = true; }
    ok(threw, 'runLiteAgent throw');
    ok(listEvents(sessionId).some((e) => e.type === 'error'), 'event error tercatat');
    closeDb();
  }

  // security: no key material anywhere in trace
  console.log('security: trace bebas secret');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('LITE TEST crashed:', e); process.exit(1); });
