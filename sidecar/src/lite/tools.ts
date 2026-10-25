/**
 * AnythingPocket sidecar — Lite mode tool set (spec §4.1).
 * read_file / list_dir / write_file, all sandboxed to the workspace dir.
 * write_file is the dangerous tool: gated by approvalHandler (default REJECT).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';

const MAX_READ_BYTES = 2 * 1024 * 1024; // 2MB read cap

export interface LiteToolContext {
  workspace: string;
  sessionId: string;
  turnId: string;
  emit: (type: import('../schema.ts').EventType, payload: Record<string, unknown>) => void;
  /** Return true to allow execution; false/timeout = reject (default REJECT, spec §6). */
  approvalHandler: (req: { tool: string; path: string; content: string; diff: string | null }) => Promise<boolean>;
}

/** Resolve p against workspace and enforce containment (blocks ../ escape & outside-absolute). */
export function resolveInWorkspace(workspace: string, p: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new Error('path kosong');
  const full = path.resolve(workspace, p);
  const root = path.resolve(workspace) + path.sep;
  if (full !== path.resolve(workspace) && !full.startsWith(root)) {
    throw new Error(`path di luar workspace ditolak: ${p}`);
  }
  return full;
}

export function argsHash(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);
}

function simpleDiff(before: string | null, after: string): string {
  if (before === null) return `(file baru)\n+ ${after.split('\n').length} baris`;
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

export function createLiteTools(ctx: LiteToolContext) {
  return {
    read_file: tool({
      description: 'Read a text file inside the sandboxed workspace (max 2MB).',
      inputSchema: z.object({ path: z.string().describe('Relative or absolute path inside the workspace') }),
      execute: ({ path: p }) => {
        const full = resolveInWorkspace(ctx.workspace, p);
        const st = fs.statSync(full);
        if (st.size > MAX_READ_BYTES) throw new Error(`file >2MB ditolak (${st.size} bytes)`);
        return { path: p, content: fs.readFileSync(full, 'utf8') };
      },
    }),
    list_dir: tool({
      description: 'List entries of a directory inside the sandboxed workspace.',
      inputSchema: z.object({ path: z.string().default('.').describe('Directory path inside the workspace') }),
      execute: ({ path: p = '.' }) => {
        const full = resolveInWorkspace(ctx.workspace, p);
        return { path: p, entries: fs.readdirSync(full, { withFileTypes: true }).map((d) => `${d.name}${d.isDirectory() ? '/' : ''}`) };
      },
    }),
    write_file: tool({
      description: 'Write a text file inside the sandboxed workspace. DANGEROUS: requires user approval.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path: p, content }) => {
        const full = resolveInWorkspace(ctx.workspace, p); // throws (reject) if escaping
        const existed = fs.existsSync(full);
        const before = existed ? fs.readFileSync(full, 'utf8') : null;
        const diff = simpleDiff(before, content);
        const args = { tool: 'write_file', path: p, content, diff };
        ctx.emit('approval.requested', {
          approvalId: p, tool: 'write_file', command: p, diff, ttlMs: 30_000,
        });
        const approved = await ctx.approvalHandler(args);
        ctx.emit(approved ? 'approval.granted' : 'approval.rejected', { approvalId: p });
        if (!approved) return { ok: false, rejected: true, path: p };
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        return { ok: true, path: p, bytes: Buffer.byteLength(content) };
      },
    }),
  };
}
