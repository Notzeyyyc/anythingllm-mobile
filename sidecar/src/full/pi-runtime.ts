/**
 * AnythingPocket sidecar — PiRuntime (spec §4.2): first HarnessRuntime impl.
 * Pi host-process (@ai-sdk/harness + @ai-sdk/harness-pi, versions PINNED per
 * spike GO, spec §8). Maps Pi lifecycle callbacks onto the single trace
 * schema, runs Pi builtin tools inside @ai-sdk/sandbox-just-bash OverlayFs
 * rooted at the workspace, and gates dangerous host tool (write_file) through
 * the same Promise-based approval contract as Lite. Interrupt = AbortSignal
 * into HarnessAgent.stream → turn.end ok:false reason 'interrupted'.
 *
 * ponytail: Pi builtin `write`/`edit`/`bash` stay allow-all INSIDE the sandbox
 * (in-memory overlay, contained); approval gate covers our host tools. Wire
 * permissionMode-driven pending approvals when the API settles (partial
 * sandbox status — see docs/m2a-full-runtime.md).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createPi } from '@ai-sdk/harness-pi';
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import { createJustBashNetworkSandboxSession } from '@ai-sdk/sandbox-just-bash';
import { OverlayFs } from 'just-bash';
import { z } from 'zod';
import type { HarnessRuntime, RunTurnInput, RunTurnResult, RuntimeApprovalHandler } from './HarnessRuntime.ts';

// any: experimental harness callback payloads, shape documented by the spike
// (spikes/pi/README.md); field access is defensive (?. + fallbacks).
/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_READ_BYTES = 2 * 1024 * 1024;

export interface PiRuntimeOptions {
  /** Provider base URL — pass the SECRETS PROXY url in production wiring. */
  baseUrl: string;
  /** API key as seen by the agent process. With the secrets proxy this is a
   *  placeholder; the proxy injects the real key upstream (spec §6). */
  apiKey: string;
  model: string;              // '<provider>/<model-id>'
  providerName?: string;      // default '9router'
  ttlMs?: number;             // approval TTL (default 30s, enforced by caller)
}

function resolveInWorkspace(workspace: string, p: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new Error('path kosong');
  const full = path.resolve(workspace, p);
  const root = path.resolve(workspace) + path.sep;
  if (full !== path.resolve(workspace) && !full.startsWith(root)) {
    throw new Error(`path di luar workspace ditolak: ${p}`);
  }
  return full;
}

function argsHash(args: unknown): string {
  // same hashing contract as lite/tools.ts
  return createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);
}

export class PiRuntime implements HarnessRuntime {
  readonly name = 'pi';
  private readonly opts: PiRuntimeOptions;
  private readonly active = new Map<string, AbortController>();

  constructor(opts: PiRuntimeOptions) {
    this.opts = opts;
  }

  interrupt(turnId: string): void {
    this.active.get(turnId)?.abort();
  }

  /** Host tools executed in OUR process (vs Pi builtins inside the sandbox).
   *  Plain Tool objects (shape-compatible with AI SDK Tool); cast at the
   *  HarnessAgent call site because harness bundles ai@7 types vs ai@5 here. */
  private hostTools(input: RunTurnInput) {
    const read_file = {
      description: 'Read a text file inside the sandboxed workspace (max 2MB).',
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path: p }: { path: string }) => {
        const full = resolveInWorkspace(input.workspace, p);
        const st = fs.statSync(full);
        if (st.size > MAX_READ_BYTES) throw new Error(`file >2MB ditolak (${st.size} bytes)`);
        return { path: p, content: fs.readFileSync(full, 'utf8') };
      },
    };
    const list_dir = {
      description: 'List entries of a directory inside the sandboxed workspace.',
      inputSchema: z.object({ path: z.string().default('.') }),
      execute: ({ path: p = '.' }: { path?: string }) => {
        const full = resolveInWorkspace(input.workspace, p ?? '.');
        return {
          path: p ?? '.',
          entries: fs.readdirSync(full, { withFileTypes: true })
            .map((d: { name: string; isDirectory(): boolean }) => `${d.name}${d.isDirectory() ? '/' : ''}`),
        };
      },
    };
    const write_file = {
      description: 'Write a text file inside the sandboxed workspace. DANGEROUS: requires user approval.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path: p, content }: { path: string; content: string }) => {
        const full = resolveInWorkspace(input.workspace, p);
        const existed = fs.existsSync(full);
        const before = existed ? fs.readFileSync(full, 'utf8') : null;
        const diff = before === null
          ? `(file baru)\n+ ${content.split('\n').length} baris`
          : diffLines(before, content);
        const res: { approved: boolean; approvalId: string } = await input.approvalHandler({
          tool: 'write_file', path: p, content, diff,
        });
        input.emit(res.approved ? 'approval.granted' : 'approval.rejected', { approvalId: res.approvalId });
        if (!res.approved) return { ok: false, rejected: true, path: p };
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        return { ok: true, path: p, bytes: Buffer.byteLength(content) };
      },
    };
    return { read_file, list_dir, write_file } as unknown as NonNullable<ConstructorParameters<typeof HarnessAgent>[0]['tools']>;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const ac = new AbortController();
    this.active.set(input.turnId, ac);
    let sandbox: HarnessV1NetworkSandboxSession | null = null;
    const started = Date.now();
    try {
      sandbox = await createJustBashNetworkSandboxSession({
        fs: new OverlayFs({ root: path.resolve(input.workspace), mountPoint: '/' }),
      });
      const providerName = this.opts.providerName ?? '9router';
      const agent = new HarnessAgent({
        id: `pi-${input.turnId}`,
        harness: createPi({
          providers: {
            [providerName]: {
              name: providerName,
              baseUrl: this.opts.baseUrl,
              // via secrets proxy this is a placeholder, never the real key
              apiKey: this.opts.apiKey,
              models: [{
                id: this.opts.model, name: this.opts.model, api: 'openai-completions',
                input: ['text'], reasoning: false, contextWindow: 1_000_000, maxTokens: 8192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              }],
            },
          },
        }),
        model: `${providerName}/${this.opts.model}`,
        tools: this.hostTools(input),
        permissionMode: 'allow-all',
        instructions:
          'You are in a sandboxed workspace directory. Prefer the host tools read_file, list_dir and write_file ' +
          '(write_file needs user approval). Keep answers short.',
        onLanguageModelCallStart: (e: any) => {
          input.emit('llm.call.start', { model: String(e?.modelId ?? 'unknown') });
        },
        onLanguageModelCallEnd: (e: any) => {
          input.emit('llm.call.end', {
            model: String(e?.modelId ?? 'unknown'),
            durationMs: Number(e?.performance?.responseTimeMs ?? Date.now() - started),
            tokensIn: e?.usage?.inputTokens ?? undefined,
            tokensOut: e?.usage?.outputTokens ?? undefined,
          });
        },
        onToolExecutionStart: (e: any) => {
          input.emit('tool.call.start', {
            tool: String(e?.toolCall?.toolName ?? 'unknown'),
            argsHash: argsHash(e?.toolCall?.input ?? {}),
          });
        },
        onToolExecutionEnd: (e: any) => {
          input.emit('tool.call.end', {
            tool: String(e?.toolCall?.toolName ?? 'unknown'),
            ok: !e?.error,
            durationMs: Number(e?.toolExecutionMs ?? 0),
          });
        },
      });
      const session = await agent.createSession({ sandboxSession: sandbox });
      const result = await agent.stream({
        session,
        prompt: input.prompt,
        abortSignal: ac.signal,
      });
      let text = '';
      for await (const delta of (result as any).textStream) {
        text += delta;
        input.onDelta?.(delta);
      }
      this.active.delete(input.turnId);
      try { await session.stop(); } catch { /* generate ends the session */ }
      return { ok: true, text };
    } catch (e) {
      this.active.delete(input.turnId);
      const msg = e instanceof Error ? e.message : String(e);
      if (ac.signal.aborted) {
        return { ok: false, text: null, reason: 'interrupted', error: 'interrupted' };
      }
      return { ok: false, text: null, error: msg.slice(0, 500) };
    } finally {
      try { await sandbox?.destroy(); } catch { /* best effort */ }
    }
  }
}

function diffLines(before: string, after: string): string {
  const a = before.split('\n'), b = after.split('\n');
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) out.push(`- ${a[i]}`);
      if (b[i] !== undefined) out.push(`+ ${b[i]}`);
    }
  }
  return out.join('\n') || '(identik)';
}
