import { HarnessAgent } from '@ai-sdk/harness/agent';
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import { createJustBashNetworkSandboxSession } from '@ai-sdk/sandbox-just-bash';
import { OverlayFs } from 'just-bash';
import { createPi } from '@ai-sdk/harness-pi';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { list_dir, read_file } from './tools.js';

// Sandbox: just-bash OverlayFs rooted AT the workspace dir (writes in-memory,
// reads from the real dir) — matches spec §8 host-process `@ai-sdk/sandbox-just-bash`.
const WORKSPACE = path.resolve(import.meta.dirname, 'workspace');
const sandboxSession: HarnessV1NetworkSandboxSession =
  await createJustBashNetworkSandboxSession({
    fs: new OverlayFs({ root: WORKSPACE, mountPoint: '/' }),
  });

const OUT = path.resolve(import.meta.dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

// --- JSONL trace sink: one line per lifecycle event (spec §7.1: satu schema) ---
const tracePath = path.join(OUT, 'trace.jsonl');
fs.writeFileSync(tracePath, '');
let seq = 0;
function dump(type: string, payload: Record<string, unknown>) {
  fs.appendFileSync(
    tracePath,
    JSON.stringify({ seq: seq++, ts: Date.now(), type, ...payload }) + '\n',
  );
}

const agent = new HarnessAgent({
  id: 'pi-spike',
  harness: createPi({
    providers: {
      '9router': {
        name: '9router',
        baseUrl: 'http://127.0.0.1:20128/v1',
        // key dibaca dari file saat runtime — tidak pernah masuk kode/log/trace
        apiKey: fs.readFileSync('/root/.secrets/9router_local_key.txt', 'utf8').trim(),
        models: [
          {
            id: 'ngd/ngodeai/gemini-3.8-flash',
            name: 'gemini-3.8-flash',
            api: 'openai-completions',
            input: ['text'],
            reasoning: false,
            contextWindow: 1_000_000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
  model: '9router/ngd/ngodeai/gemini-3.8-flash',
  tools: { read_file, list_dir },
  permissionMode: 'allow-all',
  instructions:
    'You are in a sandboxed workspace directory. Use the read_file and list_dir tools to inspect files. Keep answers short.',
  onLanguageModelCallStart: (event) => {
    dump('lm_start', { callId: event.callId, modelId: event.modelId, provider: event.provider });
  },
  onLanguageModelCallEnd: (event) => {
    dump('lm_end', {
      callId: event.callId,
      modelId: event.modelId,
      finishReason: event.finishReason,
      usage: event.usage,
      responseTimeMs: event.performance?.responseTimeMs,
    });
  },
  onToolExecutionStart: (event) => {
    dump('tool_start', {
      callId: event.callId,
      toolCallId: event.toolCall.toolCallId,
      toolName: event.toolCall.toolName,
      input: event.toolCall.input,
    });
  },
  onToolExecutionEnd: (event) => {
    dump('tool_end', {
      callId: event.callId,
      toolCallId: event.toolCall.toolCallId,
      toolName: event.toolCall.toolName,
      toolExecutionMs: event.toolExecutionMs,
      toolOutput: event.toolOutput,
    });
  },
  onStepStart: (event) => {
    dump('step_start', { callId: event.callId, stepNumber: event.stepNumber });
  },
  onStepEnd: (event) => {
    dump('step_end', {
      callId: event.callId,
      stepNumber: event.stepNumber,
      finishReason: event.finishReason,
      usage: event.usage,
    });
  },
  onEnd: (event) => {
    dump('end', { callId: event.callId, finalStepNumber: event.stepNumber, usage: event.usage });
  },
});

// --- run the prompt: tool loop must actually execute tools ---
const session = await agent.createSession({ sandboxSession });
const prompt =
  'Read the file notes.txt with read_file, then list the workspace root with list_dir, then write a one-sentence summary of notes.txt to summary.txt using your write tool.';
console.log('PROMPT:', prompt);
const result = await agent.generate({ session, prompt });
console.log('--- final text ---');
console.log(result.text);

// --- self-check asserts (exit 0 = pass) ---
const events = fs
  .readFileSync(tracePath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const types = new Set(events.map((e) => e.type));
const toolStarts = events.filter((e) => e.type === 'tool_start');
const toolEnds = events.filter((e) => e.type === 'tool_end');

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`PASS: ${msg}`);
};

assert(events.length > 10, `trace has >10 events (${events.length})`);
assert(
  ['tool_start', 'tool_end', 'step_start', 'step_end', 'lm_start', 'lm_end', 'end'].every((t) =>
    types.has(t),
  ),
  `all 7 lifecycle event types present (${[...types].sort().join(',')})`,
);
assert(toolStarts.length >= 2, `>=2 tool_start events (${toolStarts.length})`);
const startIds = new Set(toolStarts.map((e) => e.toolCallId));
const endIds = new Set(toolEnds.map((e) => e.toolCallId));
assert(
  toolStarts.length === toolEnds.length && [...startIds].every((id) => endIds.has(id)),
  `every tool_start has matching tool_end (${startIds.size} toolCallIds)`,
);
const summaryCall = toolEnds.find((e) => e.toolName === 'write');
assert(!!summaryCall, 'agent used Pi write tool');
// just-bash overlay writes are in-memory and session.stop() discards them,
// so verify content through the sandbox session BEFORE stop() — session still open here.
const wroteAbs = /Wrote (\S+)/.exec(String(summaryCall?.toolOutput?.output ?? ''))?.[1] ?? '';
assert(
  wroteAbs.endsWith('summary.txt'),
  `write targeted summary.txt (${wroteAbs})`,
);
const summaryText = await sandboxSession.readTextFile({ path: wroteAbs });
assert(
  typeof summaryText === 'string' && summaryText.length > 0,
  `summary.txt content persisted in sandbox overlay (${String(summaryText).slice(0, 80)})`,
);
try {
  await session.stop();
} catch {
  // generate() already ended the harness session after the final turn
}
assert(
  !JSON.stringify(events).includes('sk-'),
  'no API key material leaked into trace',
);

const byType: Record<string, number> = {};
for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
console.log('EVENT COUNTS:', JSON.stringify(byType));
console.log('TRACE FILE:', tracePath);
console.log('ALL CHECKS PASSED');
