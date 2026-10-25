/**
 * AnythingPocket sidecar — Lite agent loop (spec §4.1).
 * AI SDK 5 streamText + stopWhen multi-step, tools from tools.ts,
 * trace events via the single schema (db.insertEvent). No new event names.
 */
import { streamText, stepCountIs, type LanguageModel } from 'ai';
import { createLiteTools, argsHash, type LiteToolContext } from './tools.ts';
import type { EventType } from '../schema.ts';

export interface LiteAgentOptions {
  model: LanguageModel;
  prompt: string;
  sessionId: string;
  turnId: string;
  workspace: string;
  maxSteps?: number;
  approvalHandler: LiteToolContext['approvalHandler'];
  /** Trace sink (db.insertEvent bound to session/turn). */
  emit: (type: EventType, payload: Record<string, unknown>) => void;
  /** Stream text deltas (WS turn.delta). CLI ignores it. */
  onDelta?: (delta: string) => void;
}

export interface LiteRunResult {
  text: string;
  steps: number;
  toolCalls: number;
  durationMs: number;
}

const MAX_RETRIES = 2;

export async function runLiteAgent(opts: LiteAgentOptions): Promise<LiteRunResult> {
  const started = Date.now();
  let steps = 0, toolCalls = 0;

  const run = async (): Promise<string> => {
    const result = streamText({
      model: opts.model,
      prompt: opts.prompt,
      tools: createLiteTools({
        workspace: opts.workspace,
        sessionId: opts.sessionId,
        turnId: opts.turnId,
        emit: opts.emit,
        approvalHandler: opts.approvalHandler,
      }),
      stopWhen: stepCountIs(opts.maxSteps ?? 8),
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'start-step':
          steps++;
          opts.emit('llm.call.start', { model: (opts.model as { modelId?: string }).modelId ?? 'unknown' });
          break;
        case 'text-delta':
          opts.onDelta?.(part.text);
          break;
        case 'tool-call':
          toolCalls++;
          opts.emit('tool.call.start', { tool: part.toolName, argsHash: argsHash(part.input) });
          break;
        case 'tool-result':
          opts.emit('tool.call.end', { tool: part.toolName, ok: !(part as { error?: unknown }).error, durationMs: 0 });
          break;
        case 'tool-error':
          toolCalls = Math.max(toolCalls, 1); // counted at tool-call
          opts.emit('tool.call.end', { tool: part.toolName, ok: false, durationMs: 0 });
          break;
        case 'finish-step': {
          opts.emit('llm.call.end', {
            model: (opts.model as { modelId?: string }).modelId ?? 'unknown',
            durationMs: Date.now() - started,
            tokensIn: part.usage?.inputTokens ?? undefined,
            tokensOut: part.usage?.outputTokens ?? undefined,
          });
          break;
        }
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
    return await result.text;
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const text = await run();
      opts.emit('turn.end', { ok: true });
      return { text, steps, toolCalls, durationMs: Date.now() - started };
    } catch (e) {
      lastErr = e;
      opts.emit('turn.end', { ok: false });
      const msg = e instanceof Error ? e.message : String(e);
      const isNetwork = /fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT|socket|timeout/i.test(msg);
      if (!isNetwork || attempt === MAX_RETRIES) break;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  opts.emit('error', { message: msg.slice(0, 500) });
  throw lastErr;
}
