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

export interface PocketChatEntry {
  role: 'user' | 'assistant';
  text: string;
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

export class PocketChatStore {
  status: PocketStatus = 'disconnected';
  entries: PocketChatEntry[] = [];
  streamingText = '';
  /** 1-based step counter shown as "Langkah N" — derived from trace events. */
  step = 0;
  lastTrace: { key: string; tool?: string } | null = null;
  pendingApproval: (ApprovalRequest & { expiresAt: number }) | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  async loadHistory() {
    try {
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      if (raw) this.entries = JSON.parse(raw);
    } catch {}
  }

  private async persist() {
    try {
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(this.entries));
    } catch {}
  }

  clearHistory() {
    this.entries = [];
    return this.persist();
  }

  setStatus(s: PocketStatus) {
    this.status = s;
  }

  appendStreaming(delta: string) {
    this.streamingText += delta;
  }

  finishTurn(ok: boolean, text?: string, error?: string) {
    const finalText = text ?? (this.streamingText || error || '');
    if (finalText) this.entries = [...this.entries, { role: 'assistant', text: finalText }];
    this.streamingText = '';
    this.pendingApproval = null;
    this.lastTrace = null;
    return this.persist();
  }

  addUserEntry(text: string) {
    this.entries = [...this.entries, { role: 'user', text }];
    this.streamingText = '';
    this.step = 0;
    this.lastTrace = null;
    return this.persist();
  }

  onTrace(ev: TraceEvent) {
    if (ev.type.startsWith('tool.call.') || ev.type === 'llm.call.start') this.step += 1;
    const label = traceLabel(ev);
    if (label.key) this.lastTrace = label;
  }

  setApproval(req: ApprovalRequest | null) {
    this.pendingApproval = req
      ? { ...req, expiresAt: Date.now() + req.ttlMs }
      : null;
  }
}

export const pocketChatStore = new PocketChatStore();
export default pocketChatStore;
