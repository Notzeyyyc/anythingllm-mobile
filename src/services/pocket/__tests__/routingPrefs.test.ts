/* eslint-env jest */
import {
  DEFAULT_PREFS,
  loadRoutingPrefs,
  resolveRuntimeField,
  saveRoutingPrefs,
  shouldFallbackOnDevice,
} from '../routingPrefs';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => void store.set(k, v),
    },
  };
});

describe('routing preference logic (M3 spec §4.4)', () => {
  it('Manual sends the pinned runtime; per-chat override wins', () => {
    const manual = { ...DEFAULT_PREFS, mode: 'manual' as const, manualRuntime: 'full' as const };
    expect(resolveRuntimeField(manual)).toBe('full');
    expect(resolveRuntimeField(manual, 'lite')).toBe('lite');
    expect(resolveRuntimeField({ ...manual, manualRuntime: 'lite' })).toBe('lite');
  });

  it('Smart never sends runtime — the server router decides', () => {
    const smart = { ...DEFAULT_PREFS, mode: 'smart' as const };
    expect(resolveRuntimeField(smart)).toBeUndefined();
    // Even an override stays out of the request in Smart mode (HP only renders route.decided).
    expect(resolveRuntimeField(smart, 'lite')).toBeUndefined();
  });

  it('fallback policy: only on-device policy + disconnected falls back', () => {
    const onDevice = { ...DEFAULT_PREFS, fallback: 'on-device' as const };
    const stop = { ...DEFAULT_PREFS, fallback: 'stop' as const };
    expect(shouldFallbackOnDevice(onDevice, 'disconnected')).toBe(true);
    expect(shouldFallbackOnDevice(onDevice, 'connected')).toBe(false);
    expect(shouldFallbackOnDevice(onDevice, 'connecting')).toBe(false);
    expect(shouldFallbackOnDevice(stop, 'disconnected')).toBe(false);
  });

  it('prefs round-trip through AsyncStorage with defaults for missing fields', async () => {
    expect(await loadRoutingPrefs()).toEqual(DEFAULT_PREFS);
    await saveRoutingPrefs({ ...DEFAULT_PREFS, mode: 'smart', lightCompute: 'on-device' });
    expect(await loadRoutingPrefs()).toEqual({
      ...DEFAULT_PREFS,
      mode: 'smart',
      lightCompute: 'on-device',
    });
  });
});
