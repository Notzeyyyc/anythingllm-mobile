/**
 * Render smoke test for the single-screen Pocket (chip + connection panel +
 * always-rendered chat). Prevention for the "full black" class of bug:
 * asserts that the i18n strings actually appear in the tree for each state.
 */
import React from 'react';
import { Text, TextInput, TouchableOpacity } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import SafeView from '@/components/SafeView';
import pocketChatStore from '@/services/pocket/chatStore';

jest.mock('react-native-safe-area-context', () => {
  const rn = require('react-native');
  return {
    SafeAreaView: rn.View,
    SafeAreaProvider: rn.View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('react-native-linear-gradient', () => require('react-native').View);
// mobx-react pulls react-dom in the jest (non-native) build — stub it.
jest.mock('mobx-react', () => ({
  observer: (fn: unknown) => fn,
}));

jest.mock('@/hooks/useTheme', () => () => ({
  colors: {
    background: '#fff',
    text: '#000',
    textSecondary: '#666',
    secondary: '#00f',
    error: '#f00',
    placeholder: '#999',
    surfaceContainer: '#eee',
    surfaceContainerHighest: '#ddd',
  },
}));

jest.mock('@/services/pocket/tokenStore', () => ({
  loadHost: jest.fn(async () => mockSavedHost),
  loadSessionToken: jest.fn(async () => 'hbs_test'),
  saveConnection: jest.fn(async () => {}),
  forgetConnection: jest.fn(async () => {}),
}));

jest.mock('@/services/pocket/connectionSingleton', () => ({
  connectPocket: jest.fn(),
  disconnectPocket: jest.fn(),
  reconnectPocket: jest.fn(() => true),
  sendPocketTurn: jest.fn(() => true),
  respondPocketApproval: jest.fn(),
  storeSessionToken: jest.fn(async () => {}),
}));

jest.mock('@/hooks/useOnboardingHook', () => ({
  completeOnboarding: jest.fn(async () => {}),
}));

jest.mock('@/services/pocket/traceExport', () => ({ shareTrace: jest.fn(async () => {}) }));

let mockSavedHost: string | null = null;

/** Render with the fork's SafeView so class-name-based layout is included. */
async function render(element: any): Promise<any> {
  let tree!: any;
  await act(async () => {
    tree = TestRenderer.create(element);
  });
  return tree;
}

/** All text strings in the tree (leaf Text nodes, incl. TextInput placeholders). */
function texts(tree: any): string[] {
  const out: string[] = [];
  tree.root.findAllByType(Text as any).forEach(n => {
    const children = Array.isArray(n.props.children) ? n.props.children : [n.props.children];
    children.forEach(c => typeof c === 'string' && out.push(c));
  });
  tree.root.findAllByType(TextInput as any).forEach(n => typeof n.props.placeholder === 'string' && out.push(n.props.placeholder));
  return out;
}

function hasText(tree: any, s: string) {
  return texts(tree).some(t => t.includes(s));
}

import '@/i18n';
import Pocket from '../index';

describe('Pocket render smoke (no blank screens)', () => {
  it('unpaired state shows chip + inline pairing form and empty chat below', async () => {
    mockSavedHost = null;
    pocketChatStore.setStatus('disconnected');
    const tree = await render(<Pocket />);
    // Status chip
    expect(hasText(tree, 'Disconnected — retrying in the background')).toBe(true);
    // Pairing form inline in the panel
    expect(hasText(tree, 'Server address')).toBe(true);
    expect(hasText(tree, 'hbk_...')).toBe(true);
    expect(hasText(tree, 'Connect')).toBe(true);
    // Chat area always present below the panel
    expect(hasText(tree, 'Ask your server something to get started.')).toBe(true);
  });

  it('connecting state shows chip spinner text and connecting panel', async () => {
    mockSavedHost = 'ws://10.0.0.5:7443/ws';
    pocketChatStore.setStatus('connecting');
    const tree = await render(<Pocket />);
    expect(hasText(tree, 'Connecting…')).toBe(true);
    expect(hasText(tree, 'Connecting to server...')).toBe(true);
    expect(hasText(tree, 'Ask your server something to get started.')).toBe(true);
  });

  it('offline state shows error panel with retry and change-server buttons', async () => {
    mockSavedHost = 'ws://10.0.0.5:7443/ws';
    pocketChatStore.setStatus('disconnected');
    const tree = await render(<Pocket />);
    expect(hasText(tree, 'Could not reach the server.')).toBe(true);
    expect(hasText(tree, 'Try again')).toBe(true);
    expect(hasText(tree, 'Change server')).toBe(true);
    // Retry button actually wired to reconnect
    const retryBtn = tree.root.findAllByType(TouchableOpacity as any).find(n => {
      const kids = (n.props.children as any) ?? [];
      const arr = Array.isArray(kids) ? kids : [kids];
      return arr.some(
        (k: any) => k?.type === Text && k?.props?.children === 'Try again',
      );
    });
    expect(retryBtn).toBeTruthy();
    act(() => {
      retryBtn!.props.onPress();
    });
    const { reconnectPocket } = require('@/services/pocket/connectionSingleton');
    expect(reconnectPocket).toHaveBeenCalled();
  });

  it('connected state collapses the panel and shows the chat input', async () => {
    mockSavedHost = 'ws://10.0.0.5:7443/ws';
    pocketChatStore.setStatus('connected');
    const tree = await render(<Pocket />);
    expect(hasText(tree, '✅ Connected — safe and encrypted')).toBe(true);
    expect(hasText(tree, 'Ask something…')).toBe(true);
    // Panel is collapsed: no host line, no Forget button
    expect(hasText(tree, 'Forget')).toBe(false);
    // Tapping the chip expands the panel with the host + management buttons
    const chip = tree.root.findAllByType(TouchableOpacity as any).find(n => {
      const kids = (n.props.children as any) ?? [];
      const arr = Array.isArray(kids) ? kids : [kids];
      return arr.some((k: any) =>
        typeof k?.props?.children === 'string' &&
        k.props.children.includes('Connected — safe'),
      );
    });
    expect(chip).toBeTruthy();
    act(() => {
      chip!.props.onPress();
    });
    expect(hasText(tree, 'Host: ws://10.0.0.5:7443/ws')).toBe(true);
    expect(hasText(tree, 'Forget')).toBe(true);
    expect(hasText(tree, 'Re-pair')).toBe(true);
  });

  it('SafeView container keeps flex-1 (blank-screen regression)', async () => {
    mockSavedHost = 'ws://10.0.0.5:7443/ws';
    pocketChatStore.setStatus('connected');
    const tree = await render(<Pocket />);
    const safe = tree.root.findByType(SafeView as any);
    expect(safe.props.scrollable).toBe(false);
    expect(safe.props.containerClassNames).toContain('flex-1');
  });
});
