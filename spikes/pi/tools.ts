import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ponytail: sandbox = fixed dir, no escaping check beyond join+prefix; tighten for real sidecar
const WORKSPACE = path.resolve(import.meta.dirname, 'workspace');

function safeJoin(rel: string): string {
  const p = path.resolve(WORKSPACE, rel);
  if (p !== WORKSPACE && !p.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return p;
}

export const read_file = tool({
  description: 'Read a text file inside the workspace sandbox. Args: path (relative).',
  inputSchema: z.object({ path: z.string().describe('Relative path inside workspace') }),
  execute: async ({ path: rel }: { path: string }) => {
    return fs.readFileSync(safeJoin(rel), 'utf8');
  },
});

export const list_dir = tool({
  description: 'List a directory inside the workspace sandbox. Args: path (relative, "." for root).',
  inputSchema: z.object({ path: z.string().describe('Relative dir path, "." for root') }),
  execute: async ({ path: rel }: { path: string }) => {
    const p = safeJoin(rel === '.' ? '' : rel);
    return fs
      .readdirSync(p, { withFileTypes: true })
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .join('\n');
  },
});
