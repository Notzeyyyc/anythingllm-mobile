/* eslint-env jest */
import { PocketChatStore } from '../chatStore';

const ev = (type: string, tool?: string) => ({
  type,
  payload: tool ? { tool } : {},
});

describe('PocketChatStore trace summary (M2a Rangkuman)', () => {
  it('accumulates steps, tool count and duration into the turn summary', () => {
    const store = new PocketChatStore();
    void store.addUserEntry('fix the bug');
    store.onTrace(ev('turn.start'));
    store.onTrace(ev('llm.call.start'));
    store.onTrace(ev('tool.call.start', 'read_file'));
    store.onTrace(ev('tool.call.end', 'read_file'));
    store.onTrace(ev('tool.call.start', 'edit_file'));
    expect(store.turnSteps).toHaveLength(3);
    expect(store.turnTools).toBe(2);
    void store.finishTurn(true, 'done');
    const last = store.entries[store.entries.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.trace).toBeDefined();
    expect(last.trace!.steps).toHaveLength(3);
    expect(last.trace!.tools).toBe(2);
    expect(last.trace!.s).toBeGreaterThanOrEqual(0);
    // counters reset for the next turn
    expect(store.turnSteps).toHaveLength(0);
    expect(store.turnTools).toBe(0);
  });

  it('omits trace on a plain LLM-only turn with no labelled events', () => {
    const store = new PocketChatStore();
    void store.addUserEntry('hi');
    void store.finishTurn(true, 'hello');
    expect(store.entries[1].trace).toBeUndefined();
  });

  it('maps tool names to short labels for the expanded list', () => {
    const store = new PocketChatStore();
    void store.addUserEntry('x');
    store.onTrace(ev('tool.call.start', 'read_file'));
    store.onTrace(ev('tool.call.start', 'edit_file'));
    store.onTrace(ev('tool.call.start', 'bash'));
    store.onTrace(ev('tool.call.start', 'mcp_search'));
    expect(store.turnSteps.map(s => s.key)).toEqual([
      'pocket.tools.read',
      'pocket.tools.write',
      'pocket.tools.run',
      'pocket.tools.generic',
    ]);
    expect(store.turnSteps[3].tool).toBe('mcp_search');
  });
});
