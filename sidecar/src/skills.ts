/**
 * AnythingPocket sidecar — skills index + deterministic contextual load (spec §7.3).
 * Format agentskills.io: <skillsDir>/<skill-name>/SKILL.md with YAML frontmatter
 * (name, description) + markdown body. READ-ONLY in M2b — no skill authoring
 * from the agent.
 *
 * Matching is DETERMINISTIC (no LLM): case-insensitive keyword overlap between
 * the prompt and name+description. ≥1 keyword match loads the top skill(s).
 * Loaded skill body is injected into that turn's system/prompt context and a
 * skill.loaded trace event records {skill, matchedOn}.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SkillEntry {
  name: string;
  description: string;
  path: string; // SKILL.md path
  body: string;
}

export function skillsDir(): string {
  return path.resolve(
    process.env.POCKET_SKILLS_DIR
      ?? path.join(path.resolve(import.meta.dirname, '../data'), 'skills'),
  );
}

/** Parse agentskills.io frontmatter: ---\nkey: value\n---\nbody */
export function parseSkillMd(raw: string, source: string): { name: string; description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`${source}: SKILL.md tanpa frontmatter YAML`);
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  if (!fm.name || !fm.description) throw new Error(`${source}: frontmatter butuh name + description`);
  return { name: fm.name, description: fm.description, body: m[2].trim() };
}

/** Index all SKILL.md under dir (non-recursive per agentskills.io layout: <skill>/SKILL.md). */
export function indexSkills(dir: string = skillsDir()): SkillEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // missing/empty skills dir = clean no-op
  }
  const out: SkillEntry[] = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const p = path.join(dir, d.name, 'SKILL.md');
    try {
      const parsed = parseSkillMd(fs.readFileSync(p, 'utf8'), p);
      out.push({ ...parsed, path: p });
    } catch {
      // invalid skill = skip, never crash startup
    }
  }
  return out;
}

export interface SkillMatch {
  skill: SkillEntry;
  matchedOn: string[]; // keywords that matched
}

/** Deterministic keyword match: words in prompt found in name+description. */
export function matchSkills(prompt: string, skills: SkillEntry[], max = 2): SkillMatch[] {
  const words = new Set(
    prompt.toLowerCase().split(/[^a-z0-9_-]+/).filter((w) => w.length >= 3),
  );
  if (words.size === 0) return [];
  const scored: SkillMatch[] = [];
  for (const skill of skills) {
    const haystack = `${skill.name} ${skill.description}`.toLowerCase();
    const matched = [...words].filter((w) => haystack.includes(w));
    if (matched.length > 0) scored.push({ skill, matchedOn: matched });
  }
  scored.sort((a, b) => b.matchedOn.length - a.matchedOn.length);
  return scored.slice(0, max);
}

/** Compose the injection block for a turn's prompt context (empty = no match). */
export function skillInjection(matches: SkillMatch[]): string {
  if (matches.length === 0) return '';
  return matches
    .map((m) => `# Skill: ${m.skill.name}\n${m.skill.body}`)
    .join('\n\n');
}
