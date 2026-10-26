/**
 * AnythingPocket sidecar — deterministic router (spec §4.3, "System One").
 * Rule-based, NO LLM classifier in the hot path. Every decision is one
 * sentence, recorded as route.decided in the trace. Precedence:
 * user pin (env POCKET_FORCE_RUNTIME=full|lite) > tool cues > default Lite
 * for short chat, Full when ambiguous (fail toward capability).
 */
import * as fs from 'node:fs';

export type RuntimeChoice = 'lite' | 'full';

export interface RouteDecision {
  runtime: RuntimeChoice;
  reason: string;
}

/** One-sentence tool cues: file ops, bash, edit, multi-step-ish verbs. */
const TOOL_CUE =
  /\b(buat|tulis|edit|ubah|hapus|baca|jalankan|run|write|create|read|edit|delete|grep|search|list|bash|command|file|\.txt|\.json|\.md|\.ts|\.js)\b/i;

export function routeTurn(prompt: string, opts: { forceRuntime?: string | null } = {}): RouteDecision {
  const pin = opts.forceRuntime ?? process.env.POCKET_FORCE_RUNTIME ?? null;
  if (pin === 'full' || pin === 'lite') {
    return { runtime: pin, reason: 'user pin (POCKET_FORCE_RUNTIME)' };
  }
  if (TOOL_CUE.test(prompt)) {
    return { runtime: 'full', reason: 'ada indikasi tool/file/multi-step' };
  }
  if (prompt.length > 160) {
    return { runtime: 'full', reason: 'prompt panjang — ambigu, fail toward capability' };
  }
  return { runtime: 'lite', reason: 'chat pendek tanpa indikasi tool' };
}

/** Default model settings for Full mode, read from env. Key handled by caller/proxy. */
export function fullModelConfig(): { baseUrl: string; model: string } {
  return {
    baseUrl: process.env.POCKET_BASE_URL ?? 'http://127.0.0.1:20128/v1',
    model: process.env.POCKET_MODEL ?? 'ngd/ngodeai/gemini-3.8-flash',
  };
}

/** Reads the provider API key server-side only. Never logged, never returned to child. */
export function readApiKeyServerSide(keyFile?: string): string {
  return fs.readFileSync(keyFile ?? process.env.POCKET_API_KEY_FILE ?? '/root/.secrets/9router_local_key.txt', 'utf8').trim();
}
