/**
 * Render smoke test for the Pocket screens (prevention for the "full black"
 * class of bug: a screen that renders nothing visible, e.g. the flex-less
 * container collapse in Chat or a hard-coded invisible theme). Asserts that
 * the i18n strings actually appear in the tree for each state.
 */
import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
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
  it('pairing form renders host/token inputs and connect button', async () => {
    mockSavedHost = null;
    const tree = await render(<Pocket />);
    expect(hasText(tree, 'Server address')).toBe(true);
    expect(hasText(tree, 'hbk_...')).toBe(true);
    expect(hasText(tree, 'Connect')).toBe(true);
  });

  it('connecting state shows spinner text and no dead screen', async () => {
    mockSavedHost = 'ws://10.0.0.5:7443/ws';
    pocketChatStore.setStatus('connecting');
    const tree = await render(<Pocket />);
    expect(hasText(tree, 'Connecting to server...')).toBe(true);
  });

  it('offline state shows error banner with retry and change-server buttons', async () => {
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

  it('connected empty state shows empty chat message and input', async () => {
    mockSavedHost = 'ws://10.0.0.5:7443/ws';
    pocketChatStore.setStatus('connected');
    const tree = await render(<Pocket />);
    expect(hasText(tree, 'Ask your server something to get started.')).toBe(true);
    expect(hasText(tree, 'Ask something…')).toBe(true);
  });

  it('SafeView non-scrollable container keeps flex-1 (blank-screen regression)', async () => {
    mockSavedHost = 'ws://10.0.0.5:7443/ws';
    pocketChatStore.setStatus('connected');
    const tree = await render(<Pocket />);
    const safe = tree.root.findByType(SafeView as any);
    // ChatView is the second render path; find the SafeView rendered by Chat
    const chatSafe = tree.root.findAllByType(SafeView as any).find(n => n.props.scrollable === false);
    expect(chatSafe).toBeTruthy();
    expect(chatSafe!.props.containerClassNames).toContain('flex-1');
  });
});
