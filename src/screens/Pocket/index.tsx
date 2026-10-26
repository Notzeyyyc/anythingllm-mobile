/**
 * AnythingPocket M1 — Harness Companion pairing + chat entry (spec §5.1, §9).
 * Manual entry only: host + token. QR scanning is a TODO (vision-camera is in
 * deps but no QR frame-processor plugin — no new deps in M1).
 * TOFU: first connect = trust; cert fingerprint pinning lands in M3.
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { reaction } from 'mobx';
import SafeView from '@/components/SafeView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  connectPocket,
  disconnectPocket,
} from '@/services/pocket/connectionSingleton';
import {
  forgetConnection,
  loadHost,
  loadSessionToken,
  saveConnection,
} from '@/services/pocket/tokenStore';
import pocketChatStore from '@/services/pocket/chatStore';
import { completeOnboarding } from '@/hooks/useOnboardingHook';
import useTheme from '@/hooks/useTheme';
import ChatView from './Chat';

/** Normalize what the user typed into a ws:// URL (M1: plain ws, Tailscale/LAN). */
export function normalizeHost(input: string): string {
  let host = input.trim().replace(/\/+$/, '');
  if (!/^wss?:\/\//.test(host)) host = `ws://${host}`;
  if (!/:\d+(\/|$)/.test(host)) host = host.replace(/^(ws:\/\/[^/]+)/, '$1:7443');
  return host.endsWith('/ws') ? host : `${host}/ws`;
}

export default function Pocket() {
  const { t } = useTranslation();
  // Theme comes from the upstream store (UIStore.colorScheme). Pocket used to
  // hardcode dark colors + rely on a CSS-var bg class that never resolved, so
  // on a light-scheme device the white labels were invisible and the screen
  // looked blank (only the dark inputs + blue button showed).
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [pairing, setPairing] = useState<boolean | null>(null); // null = loading
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  // auth.ok flips the status to connected: from onboarding this marks the
  // server path as finished; from Settings it is a harmless no-op. mobx
  // reaction, not a render effect — status can flip without a re-render.
  useEffect(
    () =>
      reaction(
        () => pocketChatStore.status,
        (s) => {
          if (s === 'connected') void completeOnboarding();
        },
      ),
    [],
  );

  useEffect(() => {
    (async () => {
      await pocketChatStore.loadHistory();
      const savedHost = await loadHost();
      const savedToken = await loadSessionToken();
      if (savedHost) {
        setPairing(false);
        connectPocket(normalizeHost(savedHost), null, savedToken);
      } else {
        setPairing(true);
      }
    })();
    return () => disconnectPocket();
  }, []);

  async function onConnect() {
    setError('');
    if (!host.trim() || !token.trim()) return;
    setConnecting(true);
    const url = normalizeHost(host);
    await saveConnection(url, null); // remember host even if pairing fails
    connectPocket(url, token.trim(), null);
    // The chat view shows the live status; pairing "succeeds" when auth.ok
    // arrives (status flips to connected). We surface it here once.
    setConnecting(false);
    setPairing(false);
  }

  async function onForget() {
    disconnectPocket();
    await forgetConnection();
    setHost('');
    setToken('');
    setPairing(true);
  }

  if (pairing === null) {
    return (
      <SafeView
        scrollable={false}
        safeAreaStyle={{ backgroundColor: theme.colors.background }}
        containerClassNames="flex-1 justify-center items-center">
        <ActivityIndicator size="large" />
      </SafeView>
    );
  }

  if (pairing === false) {
    return (
      <ChatView
        onUnpair={() => {
          void onForget();
        }}
        onRepair={() => setPairing(true)}
      />
    );
  }

  return (
    <SafeView
      safeAreaClassNames="pt-[21px]"
      safeAreaStyle={{ backgroundColor: theme.colors.background }}
      containerClassNames="flex-1 justify-center"
      containerStyle={{ gap: 16, paddingBottom: insets.bottom }}>
      <View className="px-[30px]" style={{ gap: 16 }}>
        <Text style={{ color: theme.colors.text, fontSize: 24, fontWeight: '500' }}>
          {t('pocket.title')}
        </Text>
        <Text style={{ color: theme.colors.textSecondary }}>
          {t('pocket.pairing.intro')}
        </Text>
        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.colors.text }}>
            {t('pocket.pairing.host_label')}
          </Text>
          <TextInput
            value={host}
            onChangeText={setHost}
            placeholder={t('pocket.pairing.host_placeholder')}
            placeholderTextColor={theme.colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            className="rounded-lg px-4 py-3"
            style={{
              backgroundColor: theme.colors.surfaceContainerHighest,
              color: theme.colors.text,
            }}
          />
        </View>
        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.colors.text }}>
            {t('pocket.pairing.token_label')}
          </Text>
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder={t('pocket.pairing.token_placeholder')}
            placeholderTextColor={theme.colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            className="rounded-lg px-4 py-3"
            style={{
              backgroundColor: theme.colors.surfaceContainerHighest,
              color: theme.colors.text,
            }}
          />
        </View>
        {!!error && <Text style={{ color: theme.colors.error }}>{error}</Text>}
        <TouchableOpacity
          onPress={onConnect}
          className="rounded-lg py-4 items-center"
          style={{ backgroundColor: '#3B82F6' }}>
          <Text
            style={{
              color: '#FFFFFF',
              fontSize: 18,
              fontWeight: '500',
            }}>
            {t('pocket.pairing.connect')}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeView>
  );
}
