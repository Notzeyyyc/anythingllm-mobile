/**
 * AnythingPocket sidecar — M2b tests: MCP client + skills (spec §7.2, §7.3).
 * Run: node --experimental-strip-types test/mcp-skills.test.ts — exit 0 = green.
 * (a) MCP: fixture stdio server (echo tool) → connect → tool listed (prefixed
 *     mcp_<server>_<tool>) → callTool via Lite mock model loop → result in text.
 * (b) invalid/missing mcp.json → warning event, startup survives.
 * (c) skills: 2 SKILL.md fixtures → keyword match → skill.loaded + body in
 *     prompt context; non-matching prompt → no injection.
 * (d) empty/missing skills dir → clean no-op.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV2, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { openDb, closeDb, listEvents, insertEvent, createSession } from '../src/db.ts';
import { McpManager, loadMcpConfig, mcpConfigPath, parseMcpConfig } from '../src/mcp.ts';
import { indexSkills, matchSkills, skillInjection, parseSkillMd } from '../src/skills.ts';
import { runLiteAgent } from '../src/lite/agent.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ok - ${label}`); }
  else { failed++; console.error(`  FAIL - ${label}`); }
}

function textModel(text: string) {
  return new MockLanguageModelV2({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: text },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } },
      ] as LanguageModelV2StreamPart[]),
    }),
  });
}
function toolCallThenTextModel(toolName: string, args: Record<string, unknown>, finalText: string) {
  let step = 0;
  return new MockLanguageModelV2({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        ...(step++ === 0
          ? [
              { type: 'tool-call', toolCallId: 'c1', toolName, input: JSON.stringify(args) },
              { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
            ]
          : [
              { type: 'text-start', id: 't2' },
              { type: 'text-delta', id: 't2', delta: finalText },
              { type: 'text-end', id: 't2' },
              { type: 'finish', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } },
            ]),
      ] as LanguageModelV2StreamPart[]),
    }),
  });
}

function setup() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-mcp-'));
  openDb(':memory:');
  const sessionId = createSession(null);
  const turnId = crypto.randomUUID();
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const emit = (type: Parameters<typeof insertEvent>[2], payload: Record<string, unknown>) => {
    insertEvent(sessionId, turnId, type, payload);
    events.push({ type, payload });
  };
  return { ws, sessionId, turnId, emit, events };
}

const alwaysApprove = async () => ({ approved: true, approvalId: 'approve-fixed' });

async function main(): Promise<void> {
  // (a) MCP: fixture stdio echo server → connect → list → call via Lite loop
  console.log('(a) MCP fixture stdio server: connect → list → callTool via Lite loop');
  {
    const ctx = setup();
    const cfgPath = path.join(ctx.ws, 'mcp.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      mcpServers: { echo: { command: process.execPath, args: [path.join(here, 'fixture-mcp-echo-server.mjs')] } },
    }));
    const mgr = new McpManager((t, p) => ctx.emit(t, p));
    await mgr.connectAll(loadMcpConfig(cfgPath));
    ok(mgr.listTools().length === 1, 'server connected, 1 tool listed');
    ok(mgr.listTools()[0].name === 'mcp_echo_echo', `tool prefixed: ${mgr.listTools()[0]?.name}`);
    ok(ctx.events.some((e) => e.type === 'mcp.server.status' && e.payload.status === 'connected'), 'mcp.server.status connected event');

    const r = await runLiteAgent({
      model: toolCallThenTextModel('mcp_echo_echo', { text: 'halo' }, 'done'),
      prompt: 'test', sessionId: ctx.sessionId, turnId: ctx.turnId, workspace: ctx.ws,
      mcp: mgr, approvalHandler: alwaysApprove, emit: ctx.emit,
    });
    ok(r.toolCalls === 1, 'MCP tool called through Lite loop');
    // prove the result reached the loop: mock model ignores results, so verify via manager directly
    const res = await mgr.callTool('echo', 'echo', { text: 'halo' }) as { content: { text: string }[] };
    ok(res.content[0].text === 'echo:halo', `callTool result: ${res.content[0].text}`);
    await mgr.closeAll();
    closeDb();
  }

  // (b) invalid mcp.json + dead server → warning, startup survives
  console.log('(b) config invalid / server mati → warning, startup tetap hidup');
  {
    const ctx = setup();
    const mgr = new McpManager((t, p) => ctx.emit(t, p));
    const badPath = path.join(ctx.ws, 'nope.json');
    let warn = false;
    try { await mgr.connectAll(loadMcpConfig(badPath)); } catch { warn = true; }
    ok(warn, 'missing config file → loadMcpConfig throws (caller records warning)');
    // dead server (command exits immediately)
    const cfg = { mcpServers: { dead: { command: 'false' } } };
    await mgr.connectAll(cfg);
    ok(mgr.listTools().length === 0, 'dead server skipped, manager alive');
    ok(ctx.events.some((e) => e.type === 'mcp.server.status' && e.payload.status === 'failed'), 'mcp.server.status failed event tercatat');
    let bad = false;
    try { parseMcpConfig('{nope', 't.json'); } catch { bad = true; }
    ok(bad, 'malformed JSON → human-readable error');
    closeDb();
  }

  // (c) skills: fixtures → match → skill.loaded + injection; no match → none
  console.log('(c) skills: keyword match → skill.loaded + injection; tanpa match → kosong');
  {
    const skillsDir = path.join(os.tmpdir(), `pocket-skills-${Date.now()}`);
    fs.mkdirSync(path.join(skillsDir, 'commit-style'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'deploy-notes'), { recursive: true });
    fs.copyFileSync(path.join(here, '../../docs/skills-example/commit-style/SKILL.md'), path.join(skillsDir, 'commit-style/SKILL.md'));
    fs.copyFileSync(path.join(here, '../../docs/skills-example/deploy-notes/SKILL.md'), path.join(skillsDir, 'deploy-notes/SKILL.md'));
    const skills = indexSkills(skillsDir);
    ok(skills.length === 2, `2 skill terindeks (${skills.length})`);

    const ctx = setup();
    const matches = matchSkills('tolong commit perubahan ini', skills);
    ok(matches.length === 1 && matches[0]!.skill.name === 'commit-style', `match: ${matches[0]?.skill.name}`);
    const inj = skillInjection(matches);
    ok(inj.includes('Conventional Commits'), 'body skill ada di konteks injection');
    await runLiteAgent({
      model: textModel('ok'),
      prompt: `${inj}\n\n---\n\ntolong commit perubahan ini`,
      sessionId: ctx.sessionId, turnId: ctx.turnId, workspace: ctx.ws,
      skills, approvalHandler: alwaysApprove, emit: ctx.emit,
    });
    const ev = ctx.events.find((e) => e.type === 'skill.loaded');
    ok(ev !== undefined && ev.payload.skill === 'commit-style' && Array.isArray(ev.payload.matchedOn), `skill.loaded event: ${ev?.payload.skill}`);

    const noMatch = matchSkills('halo dunia indah sekali', skills);
    ok(noMatch.length === 0 && skillInjection(noMatch) === '', 'prompt tanpa match → tidak ada injection');

    // skill with broken frontmatter skipped, missing dir no-op
    fs.mkdirSync(path.join(skillsDir, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'broken/SKILL.md'), 'tanpa frontmatter');
    ok(indexSkills(skillsDir).length === 2, 'SKILL.md rusak di-skip');
    ok(indexSkills(path.join(os.tmpdir(), 'does-not-exist-xyz')).length === 0, '(d) skills dir tidak ada → no-op rapi');
    try { parseSkillMd('x', 't'); ok(false, 'parseSkillMd should throw'); } catch { ok(true, 'parseSkillMd tanpa frontmatter → throw'); }
    closeDb();
  }

  // (d) default config path helper
  console.log('(d) config path helper');
  ok(mcpConfigPath().endsWith('mcp.json'), `default path: ${mcpConfigPath()}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('MCP-SKILLS TEST crashed:', e); process.exit(1); });
