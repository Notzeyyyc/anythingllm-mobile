/**
 * Read-only local cache of the chat history (spec §6): readable when the
 * server is offline. ponytail: AsyncStorage JSON per session instead of a
 * WatermelonDB model — one screen, no queries; move to the DB when we need
 * search/pagination (M2+).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { makeAutoObservable } from 'mobx';
import type { ApprovalRequest, PocketStatus, TraceEvent } from './PocketConnection';

const HISTORY_KEY = 'pocket.history';
const RAW_MODE_KEY = 'pocket.rawMode';
/** Ring buffer cap for raw trace events per turn (spec §7.1 M2b). */
export const MAX_TURN_EVENTS = 200;

/** Secret-looking payload keys are never exported (defense in depth — the
 * sidecar already sanitizes, but we export from data we hold locally). */
const SECRET_KEY = /(token|secret|password|apikey|api_key|authorization|cookie|cvc|card)/i;

export interface PocketChatEntry {
  role: 'user' | 'assistant';
  text: string;
  /** Trace summary (Rangkuman level, spec §7.1) attached to the assistant turn. */
  trace?: { steps: { key: string; tool?: string }[]; tools: number; s: number };
  /** Raw trace events for Detail/Raw viewer + export (M2b). */
  events?: TraceEvent[];
}

export function traceLabel(ev: TraceEvent): { key: string; tool?: string; n?: string } {
  const tool = String((ev.payload as any)?.tool ?? '');
  const t = ev.type;
  if (t.startsWith('tool.call.start')) {
    if (/read|glob|grep|ls/i.test(tool)) return { key: 'pocket.tools.read' };
    if (/write|edit/i.test(tool)) return { key: 'pocket.tools.write' };
    if (/bash|shell|exec/i.test(tool)) return { key: 'pocket.tools.run' };
    return { key: 'pocket.tools.generic', tool };
  }
  if (t === 'llm.call.start') return { key: 'pocket.tools.thinking' };
  return { key: '' };
}

/** Deep-strip secret-looking keys from anything headed into an export file. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redactSecrets(v);
    }
    return out;
  }
  return value;
}

/** One step for the Detail viewer: a start event paired with its end event. */
export interface StepDetail {
  key: string;
  tool?: string;
  start: TraceEvent;
  end?: TraceEvent;
}

/** Pair tool.call.start / llm.call.start events with their matching end. */
export function stepDetails(events: TraceEvent[]): StepDetail[] {
  const steps: StepDetail[] = [];
  for (const ev of events) {
    if (ev.type === 'tool.call.end') {
      const tool = String(ev.payload?.tool ?? '');
      const match = [...steps].reverse().find(s => s.tool === tool && !s.end);
      if (match) match.end = ev;
      continue;
    }
    const label = traceLabel(ev);
    if (!label.key) continue;
    if (ev.type === 'tool.call.start') {
      steps.push({
        key: traceLabel(ev).key,
        tool: String(ev.payload?.tool ?? ''),
        start: ev,
      });
    } else if (ev.type === 'llm.call.start') {
      steps.push({ key: traceLabel(ev).key, start: ev });
    }
  }
  return steps;
}

export type ExportFormat = 'markdown' | 'json';

/** Human-readable export: conversation text + steps table (spec §7.1). */
export function formatTurnMarkdown(entries: PocketChatEntry[], locale = 'en'): string {
  const lines: string[] = ['# AnythingPocket — conversation trace', ''];
  for (const e of entries) {
    lines.push(e.role === 'user' ? '## You' : '## Assistant');
    lines.push('', e.text, '');
    if (e.trace) {
      lines.push(
        `_${e.trace.steps.length} steps, ${e.trace.tools} tool calls, ${e.trace.s}s_`,
        '',
        '| # | Step | Result | Duration |',
        '|---|------|--------|----------|',
      );
      const details = stepDetails(e.events ?? []);
      details.forEach((d, i) => {
        const ok = d.end ? (d.end.payload?.ok ? 'ok' : 'fail') : '—';
        const ms = d.end?.payload?.durationMs ?? '—';
        lines.push(`| ${i + 1} | ${d.tool ?? d.key.replace('pocket.tools.', '')} | ${ok} | ${ms} ms |`);
      });
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

/** Machine-readable export: raw trace events, exactly as received. */
export function formatTurnJson(entries: PocketChatEntry[]): string {
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), events: redactSecrets(entries.flatMap(e => e.events ?? [])) },
    null,
    2,
  ) + '\n';
}

export class PocketChatStore {
  status: PocketStatus = 'disconnected';
  /** True right after the sidecar rejected our token (auth.deny) — shown as a banner. */
  authError = false;
  entries: PocketChatEntry[] = [];
  streamingText = '';
  /** 1-based step counter shown as "Langkah N" — derived from trace events. */
  step = 0;
  lastTrace: { key: string; tool?: string } | null = null;
  /** Accumulated Rangkuman trace for the current turn (spec §7.1, M2a). */
  turnSteps: { key: string; tool?: string }[] = [];
  turnTools = 0;
  turnStartTs = 0;
  /** Raw trace events for the current turn — ring buffer, oldest dropped. */
  turnEvents: TraceEvent[] = [];
  /** Raw/"mode belajar" toggle (spec §7.1 level 3, default OFF). */
  rawMode = false;
  pendingApproval: (ApprovalRequest & { expiresAt: number }) | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  async loadHistory() {
    try {
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      if (raw) this.entries = JSON.parse(raw);
    } catch {}
    try {
      this.rawMode = (await AsyncStorage.getItem(RAW_MODE_KEY)) === '1';
    } catch {}
  }

  private async persist() {
    try {
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(this.entries));
    } catch {}
  }

  setRawMode(on: boolean) {
    this.rawMode = on;
    void AsyncStorage.setItem(RAW_MODE_KEY, on ? '1' : '0').catch(() => {});
  }

  clearHistory() {
    this.entries = [];
    return this.persist();
  }

  setStatus(s: PocketStatus) {
    this.status = s;
    if (s === 'connected') this.authError = false;
  }

  setAuthError(on: boolean) {
    this.authError = on;
  }

  appendStreaming(delta: string) {
    this.streamingText += delta;
  }

  finishTurn(ok: boolean, text?: string, error?: string) {
    const finalText = text ?? (this.streamingText || error || '');
    const events = this.turnEvents.length > 0 ? this.turnEvents : undefined;
    if (finalText) {
      const trace =
        this.turnSteps.length > 0
          ? {
              steps: this.turnSteps,
              tools: this.turnTools,
              s: Math.round(((Date.now() - (this.turnStartTs || Date.now())) / 100) / 10),
            }
          : undefined;
      this.entries = [...this.entries, { role: 'assistant', text: finalText, trace, events }];
    }
    this.streamingText = '';
    this.pendingApproval = null;
    this.lastTrace = null;
    this.turnSteps = [];
    this.turnTools = 0;
    this.turnStartTs = 0;
    this.turnEvents = [];
    return this.persist();
  }

  addUserEntry(text: string) {
    this.entries = [...this.entries, { role: 'user', text }];
    this.streamingText = '';
    this.step = 0;
    this.lastTrace = null;
    this.turnSteps = [];
    this.turnTools = 0;
    this.turnStartTs = 0;
    this.turnEvents = [];
    return this.persist();
  }

  onTrace(ev: TraceEvent) {
    if (!this.turnStartTs) this.turnStartTs = Date.now();
    this.turnEvents = [...this.turnEvents.slice(-(MAX_TURN_EVENTS - 1)), ev];
    if (ev.type.startsWith('tool.call.') || ev.type === 'llm.call.start') this.step += 1;
    const label = traceLabel(ev);
    if (label.key) {
      this.lastTrace = label;
      if (ev.type === 'tool.call.start') {
        this.turnTools += 1;
        this.turnSteps = [...this.turnSteps, { key: label.key, tool: label.tool }];
      } else if (ev.type === 'llm.call.start') {
        this.turnSteps = [...this.turnSteps, { key: label.key }];
      }
    }
  }

  setApproval(req: ApprovalRequest | null) {
    this.pendingApproval = req
      ? { ...req, expiresAt: Date.now() + req.ttlMs }
      : null;
  }
}

export const pocketChatStore = new PocketChatStore();
export default pocketChatStore;
