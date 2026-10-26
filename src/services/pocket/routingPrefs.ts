/**
 * AnythingPocket M3 — Routing & Compute preferences (spec §4.4, §7.8).
 * Persisted in AsyncStorage (`pocket.routing`); the pure functions below are
 * the contract: Manual → HP sends `runtime` in turn.request (server may
 * override with POCKET_FORCE_RUNTIME), Smart → HP sends nothing, the server
 * router decides (HP only reads route.decided in trace events).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PocketStatus } from './PocketConnection';

export type RoutingMode = 'manual' | 'smart';
export type Runtime = 'lite' | 'full';
export type LightCompute = 'on-device' | 'server';
export type FallbackPolicy = 'on-device' | 'stop';

export interface RoutingPrefs {
  mode: RoutingMode;
  /** Manual mode: the runtime the user pinned (Cepat/Lite or Lengkap/Full). */
  manualRuntime: Runtime;
  /** Smart mode: where light tasks go; heavy tasks always go to the server. */
  lightCompute: LightCompute;
  /** Server dead → fall back to on-device (offline banner) or stop. */
  fallback: FallbackPolicy;
}

export const DEFAULT_PREFS: RoutingPrefs = {
  mode: 'manual',
  manualRuntime: 'full',
  lightCompute: 'server',
  fallback: 'on-device',
};

const PREFS_KEY = 'pocket.routing';

export async function loadRoutingPrefs(): Promise<RoutingPrefs> {
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function saveRoutingPrefs(prefs: RoutingPrefs): Promise<void> {
  await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

/**
 * The `runtime` field for turn.request (contract v1.2, additive): Manual →
 * the pinned choice; Smart → undefined (server router decides, HP only
 * renders route.decided). `override` is a per-chat pin that wins over prefs.
 */
export function resolveRuntimeField(
  prefs: RoutingPrefs,
  override?: Runtime | null,
): Runtime | undefined {
  if (prefs.mode === 'smart') return undefined;
  return override ?? prefs.manualRuntime;
}

/**
 * Hybrid fallback (spec §7.8): only when the policy allows on-device AND the
 * link is down (after PocketConnection gave up retrying, status returns to
 * 'disconnected'). History is kept regardless — the cache is read-only.
 */
export function shouldFallbackOnDevice(
  prefs: RoutingPrefs,
  status: PocketStatus,
): boolean {
  return prefs.fallback === 'on-device' && status === 'disconnected';
}
