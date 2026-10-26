/**
 * AnythingPocket sidecar — MCP client manager (spec §7.2).
 * Uses the STABLE @modelcontextprotocol/sdk (NOT the experimental AI SDK client).
 * Config: env POCKET_MCP_CONFIG (default <dataDir>/mcp.json), shape:
 *   {"mcpServers":{"<name>":{"command":"...","args":[...],"env":{...}} | {"url":"https://..."}}}
 *
 * SANDBOX DECISION (documented in docs/m2b-mcp-skills.md): MCP servers run in
 * the HOST process, outside the bwrap sandbox. They are external processes the
 * user explicitly picked in mcp.json — trusted-by-choice code (same trust
 * level as the sidecar itself). The sandbox exists to contain model-generated
 * bash, not user-approved servers.
 *
 * A dead/invalid server is skipped with a trace event (mcp.server.status),
 * never crashes startup. Tool defs cached per server; refreshed on reconnect.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

export const DEFAULT_MCP_CONFIG_PATH = (dataDir: string) => path.resolve(dataDir, 'mcp.json');

export function mcpConfigPath(): string {
  return process.env.POCKET_MCP_CONFIG
    ? path.resolve(process.env.POCKET_MCP_CONFIG)
    : DEFAULT_MCP_CONFIG_PATH(path.resolve(import.meta.dirname, '../data'));
}

/** Parse + shallow-validate; throws with a human-readable message on bad shape. */
export function parseMcpConfig(raw: string, source: string): McpConfig {
  const j = JSON.parse(raw) as { mcpServers?: unknown };
  if (typeof j !== 'object' || j === null || typeof j.mcpServers !== 'object' || j.mcpServers === null) {
    throw new Error(`${source}: format mcp.json harus {"mcpServers":{...}}`);
  }
  const out: McpConfig = { mcpServers: {} };
  for (const [name, e] of Object.entries(j.mcpServers as Record<string, unknown>)) {
    if (typeof e !== 'object' || e === null) continue;
    const s = e as McpServerEntry;
    if (typeof s.command === 'string') out.mcpServers[name] = s;
    else if (typeof s.url === 'string') out.mcpServers[name] = s;
    // entries with neither command nor url are skipped silently (disabled)
  }
  return out;
}

export function loadMcpConfig(configPath: string = mcpConfigPath()): McpConfig {
  return parseMcpConfig(fs.readFileSync(configPath, 'utf8'), configPath);
}

export interface McpToolDef {
  server: string;
  name: string;        // mcp_<server>_<tool>
  description?: string;
  inputSchema: unknown;
}

interface Conn {
  client: Client;
  tools: McpToolDef[];
}

export type McpEmit = (type: 'mcp.server.status', payload: Record<string, unknown>) => void;

export class McpManager {
  private readonly conns = new Map<string, Conn>();
  private readonly emit: McpEmit | null;

  constructor(emit?: McpEmit) {
    this.emit = emit ?? null;
  }

  /** Connect all configured servers; failures are recorded, never thrown. */
  async connectAll(config: McpConfig): Promise<void> {
    await Promise.all(Object.entries(config.mcpServers).map(([name, entry]) => this.connect(name, entry)));
  }

  async connect(name: string, entry: McpServerEntry): Promise<boolean> {
    try {
      const client = new Client({ name: 'anythingpocket-sidecar', version: '0.1.0' });
      const transport = entry.command
        ? new StdioClientTransport({
            command: entry.command,
            args: entry.args ?? [],
            // user-referenced env vars resolve from OUR env; never hardcoded secrets here
            env: { ...minimalEnv(), ...(entry.env ?? {}) },
          })
        : new StreamableHTTPClientTransport(new URL(entry.url!), { requestInit: { headers: entry.headers } });
      await client.connect(transport);
      const res = await client.listTools();
      const tools: McpToolDef[] = (res.tools ?? []).map((t) => ({
        server: name,
        // prefixed to never collide with Lite builtin tools or other servers
        name: `mcp_${name}_${t.name}`,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      this.conns.set(name, { client, tools });
      this.emit?.('mcp.server.status', { server: name, status: 'connected', detail: `${tools.length} tools` });
      return true;
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      this.emit?.('mcp.server.status', { server: name, status: 'failed', detail: msg });
      return false;
    }
  }

  /** Reconnect one server and refresh its cached tool defs. */
  async reconnect(name: string, entry: McpServerEntry): Promise<boolean> {
    await this.close(name);
    return this.connect(name, entry);
  }

  /** Flat tool list (cached defs). */
  listTools(): McpToolDef[] {
    return [...this.conns.values()].flatMap((c) => c.tools);
  }

  /** Proxy a call. Unknown server/tool or dead server → throws (tool error path). */
  async callTool(server: string, tool: string, args: unknown): Promise<unknown> {
    const conn = this.conns.get(server);
    if (!conn) throw new Error(`MCP server tidak terhubung: ${server}`);
    try {
      const res = await conn.client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> });
      return res;
    } catch (e) {
      // transport died → drop so next turn can reconnect
      const msg = e instanceof Error ? e.message : String(e);
      if (/closed|ECONN|ENOTFOUND|ETIMEDOUT|socket/i.test(msg)) await this.close(server);
      throw e;
    }
  }

  async close(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (!c) return;
    this.conns.delete(name);
    try { await c.client.close(); } catch { /* best effort */ }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((n) => this.close(n)));
  }
}

function minimalEnv(): Record<string, string> {
  // ponytail: pass whole env minus secrets-prone extras; MCP servers are
  // user-chosen trusted processes. Narrow to PATH/HOME/whitelist if threat
  // model changes.
  return { ...process.env } as Record<string, string>;
}
