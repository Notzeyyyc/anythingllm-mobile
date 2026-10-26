/* eslint-env jest */
import { PocketChatStore, MAX_TURN_EVENTS, stepDetails, redactSecrets, formatTurnMarkdown, formatTurnJson } from '../chatStore';

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

describe('PocketChatStore raw events (M2b Detail/Raw)', () => {
  it('stores full trace events per turn and attaches them to the entry', () => {
    const store = new PocketChatStore();
    void store.addUserEntry('fix it');
    store.onTrace(ev('turn.start'));
    store.onTrace(ev('tool.call.start', 'read_file'));
    store.onTrace(ev('tool.call.end', 'read_file'));
    void store.finishTurn(true, 'done');
    const entry = store.entries[1];
    expect(entry.events).toHaveLength(3);
    expect(entry.events![0].type).toBe('turn.start');
    // reset for next turn
    expect(store.turnEvents).toHaveLength(0);
  });

  it('caps the ring buffer at MAX_TURN_EVENTS, dropping the oldest', () => {
    const store = new PocketChatStore();
    void store.addUserEntry('x');
    for (let i = 0; i < MAX_TURN_EVENTS + 20; i++) store.onTrace(ev('turn.start'));
    expect(store.turnEvents).toHaveLength(MAX_TURN_EVENTS);
    expect(store.turnEvents[0].type).toBe('turn.start'); // all identical, still capped
  });

  it('pairs tool.call.start with its tool.call.end for the Detail viewer', () => {
    const details = stepDetails([
      ev('tool.call.start', 'read_file'),
      ev('tool.call.end', 'read_file'),
      ev('llm.call.start'),
      ev('tool.call.start', 'bash'),
    ] as any);
    expect(details).toHaveLength(3);
    expect(details[0].end?.type).toBe('tool.call.end');
    expect(details[0].tool).toBe('read_file');
    expect(details[1].key).toBe('pocket.tools.thinking');
    expect(details[2].tool).toBe('bash');
  });

  it('redacts secret-looking keys and never leaks them into exports', () => {
    const nested = redactSecrets({ a: 1, sessionToken: 'x', nested: { api_key: 'y', ok: 'z' } });
    expect(nested).toEqual({ a: 1, sessionToken: '[redacted]', nested: { api_key: '[redacted]', ok: 'z' } });
  });

  it('formats markdown export with conversation + steps table', () => {
    const store = new PocketChatStore();
    void store.addUserEntry('fix the bug');
    store.onTrace(ev('tool.call.start', 'read_file'));
    store.onTrace({ type: 'tool.call.end', payload: { tool: 'read_file', ok: true, durationMs: 5 } });
    void store.finishTurn(true, 'fixed');
    const md = formatTurnMarkdown(store.entries);
    expect(md).toContain('fix the bug');
    expect(md).toContain('fixed');
    expect(md).toContain('| 1 |');
    expect(md).toContain('ok');
  });

  it('formats JSON export with raw events, 2-space, secret-free', () => {
    const store = new PocketChatStore();
    void store.addUserEntry('hi');
    store.onTrace({ type: 'tool.call.start', payload: { tool: 'bash', argsHash: 'abc', sessionToken: 'zzz' } });
    void store.finishTurn(true, 'ok');
    const json = formatTurnJson(store.entries);
    expect(json.startsWith('{')).toBe(true);
    expect(json).not.toContain('zzz');
    expect(JSON.parse(json).events[0].payload.tool).toBe('bash');
  });
});
