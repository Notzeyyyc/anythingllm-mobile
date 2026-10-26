/**
 * Render smoke test for Settings > Routing & Compute (M3 §4.4): asserts the
 * i18n strings render for the default (Manual) prefs and that Smart mode
 * swaps the runtime picker for the light-compute picker, plus a save on tap.
 */
import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => {
  const rn = require('react-native');
  return {
    SafeAreaView: rn.View,
    SafeAreaProvider: rn.View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('@/hooks/useTheme', () => () => ({
  colors: {
    background: '#fff',
    text: '#000',
    textSecondary: '#666',
    secondary: '#00f',
    error: '#f00',
    surfaceContainer: '#eee',
    surfaceContainerHighest: '#ddd',
  },
}));
jest.mock('@/hooks/useHighjackBackButtonPress', () => () => {});
jest.mock('phosphor-react-native', () => ({ ArrowLeft: () => null }));
jest.mock('react-native-linear-gradient', () => require('react-native').View);
jest.mock('@/services/pocket/routingPrefs', () => {
  const actual = jest.requireActual('@/services/pocket/routingPrefs');
  return {
    ...actual,
    loadRoutingPrefs: jest.fn(async () => mockPrefs),
    saveRoutingPrefs: jest.fn(async () => {}),
  };
});
jest.mock('@/services/pocket/tokenStore', () => ({
  loadCertFp: jest.fn(async () => 'sha256:abc123'),
}));

import PocketRouting from '@/screens/UserSettings/PocketRouting';
import { saveRoutingPrefs } from '@/services/pocket/routingPrefs';
import '@/i18n';
import i18n from '@/i18n';

let mockPrefs: any;

async function renderPage() {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<PocketRouting goToPage={jest.fn()} />);
  });
  return tree;
}

function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree.root.findAllByType(Text as any).forEach(n => {
    const s = String(n.props.children ?? '');
    if (s) out.push(s);
  });
  return out;
}

describe('Routing & Compute settings page (M3)', () => {
  it('renders Manual mode with runtime picker and stored cert fingerprint', async () => {
    mockPrefs = {
      mode: 'manual',
      manualRuntime: 'full',
      lightCompute: 'server',
      fallback: 'on-device',
    };
    const tree = await renderPage();
    const strings = texts(tree).join('\n');
    expect(strings).toContain(i18n.t('pocket.routing.mode_manual'));
    expect(strings).toContain(i18n.t('pocket.routing.runtime_full_hint'));
    // Smart-only section hidden in Manual
    expect(strings).not.toContain(i18n.t('pocket.routing.light_compute_label'));
    expect(strings).toContain('sha256:abc123');
  });

  it('Smart mode shows light-compute preferences instead of the runtime pin', async () => {
    mockPrefs = {
      mode: 'smart',
      manualRuntime: 'full',
      lightCompute: 'server',
      fallback: 'on-device',
    };
    const tree = await renderPage();
    const strings = texts(tree).join('\n');
    expect(strings).toContain(i18n.t('pocket.routing.mode_smart'));
    expect(strings).toContain(i18n.t('pocket.routing.light_on_device_hint'));
    expect(strings).not.toContain(i18n.t('pocket.routing.manual_runtime_label'));
  });

  it('persists a preference change when an option is tapped', async () => {
    mockPrefs = {
      mode: 'manual',
      manualRuntime: 'full',
      lightCompute: 'server',
      fallback: 'on-device',
    };
    const tree = await renderPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allTexts = tree.root.findAllByType(Text as any);
    const hintNode = allTexts.find(
      n => String(n.props.children ?? '') === i18n.t('pocket.routing.mode_smart_hint'),
    );
    expect(hintNode).toBeTruthy();
    // Walk up from the hint text to the wrapping option row.
    let smartRow: any = hintNode!.parent;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    while (smartRow && smartRow.type !== (TouchableOpacity as any)) smartRow = smartRow.parent;
    expect(smartRow).toBeTruthy();
    await act(async () => {
      smartRow!.props.onPress();
    });
    expect(saveRoutingPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'smart' }),
    );
  });
});
