/**
 * MobX reactivity test for the Pocket screen. Split from render.test.tsx
 * because the observer mock must be the reactive one at file scope: jest
 * cannot re-override an already-loaded mock inside jest.isolateModules.
 *
 * Real mobx-react cannot load in the jest (non-native) build — it pulls
 * react-dom. This mock re-implements `observer` on top of mobx.Reaction with
 * the same tracking semantics (render body runs inside reaction.track; a
 * dependency change forces a re-render), so a store change really re-renders.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => {
  const rn = require('react-native');
  return {
    SafeAreaView: rn.View,
    SafeAreaProvider: rn.View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('react-native-linear-gradient', () => require('react-native').View);

const mockReact = require('react');
const mockMobx = require('mobx');
jest.mock('mobx-react', () => ({
  observer: (Comp: any) => {
    const Wrapped = (props: any) => {
      const [, force] = mockReact.useReducer((c: number) => c + 1, 0);
      const ref = mockReact.useRef(null);
      if (!ref.current) {
        ref.current = new mockMobx.Reaction('observer', () => force());
      }
      const r = ref.current;
      mockReact.useEffect(() => () => r.dispose(), []);
      let out: any;
      // Call Comp directly (not createElement) so its hookful body runs
      // inside this render pass AND inside the tracked reaction.
      r.track(() => {
        out = Comp(props);
      });
      return out;
    };
    return Wrapped;
  },
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
  loadHost: jest.fn(async () => 'ws://10.0.0.5:7443/ws'),
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

import '@/i18n';
import pocketChatStore from '@/services/pocket/chatStore';
import Pocket from '../index';

function texts(tree: any): string[] {
  const out: string[] = [];
  tree.root.findAllByType(Text as any).forEach((n: any) => {
    const children = Array.isArray(n.props.children) ? n.props.children : [n.props.children];
    children.forEach((c: any) => typeof c === 'string' && out.push(c));
  });
  return out;
}

function hasText(tree: any, s: string) {
  return texts(tree).some(t => t.includes(s));
}

describe('Pocket mobx reactivity (real observer semantics)', () => {
  it('a status change re-renders the panel text without a remount', async () => {
    pocketChatStore.setStatus('disconnected');
    let tree!: any;
    await act(async () => {
      tree = TestRenderer.create(<Pocket />);
    });
    expect(hasText(tree, 'Could not reach the server.')).toBe(true);
    await act(async () => {
      pocketChatStore.setStatus('connected');
    });
    expect(hasText(tree, '✅ Connected — safe and encrypted')).toBe(true);
  });

  it('an auth.deny flips the auth-failed banner on reactively', async () => {
    pocketChatStore.setStatus('disconnected');
    pocketChatStore.setAuthError(false);
    let tree!: any;
    await act(async () => {
      tree = TestRenderer.create(<Pocket />);
    });
    expect(hasText(tree, 'Pairing failed')).toBe(false);
    await act(async () => {
      pocketChatStore.setAuthError(true);
    });
    expect(hasText(tree, 'Pairing failed — the token looks wrong. Check it and try again.')).toBe(true);
  });
});
