/**
 * AnythingPocket M1 — Harness Companion, ONE screen (spec §5.1, §9, §7.9).
 * Status chip at the top; tapping it expands/collapses the connection panel.
 * While not connected the panel is always open (pairing form / retry / change
 * server); when connected it collapses so chat fills the screen. The chat
 * area (empty state / history / streaming / approvals / trace) is always
 * rendered below the panel — no state may render a blank screen.
 * Manual entry only: host + token. QR scanning is a TODO. TOFU: first
 * connect = trust; cert fingerprint pinning lands in M3.
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
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
  reconnectPocket,
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
import ChatBody from './Chat';

/** Normalize what the user typed into a ws:// URL (M1: plain ws, Tailscale/LAN). */
export function normalizeHost(input: string): string {
  let host = input.trim().replace(/\/+$/, '');
  if (!/^wss?:\/\//.test(host)) host = `ws://${host}`;
  if (!/:\d+(\/|$)/.test(host)) host = host.replace(/^(ws:\/\/[^/]+)/, '$1:7443');
  return host.endsWith('/ws') ? host : `${host}/ws`;
}

export default function Pocket() {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [ready, setReady] = useState(false); // finished checking saved host
  const [savedHost, setSavedHost] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false); // manual toggle when connected
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  const status = pocketChatStore.status;
  const connected = status === 'connected';
  // The panel cannot be closed while not connected (spec: pairing inline).
  const panelVisible = !connected || panelOpen;

  // auth.ok flips the status to connected: from onboarding this marks the
  // server path as finished; from Settings it is a harmless no-op.
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
      const stored = await loadHost();
      const savedToken = await loadSessionToken();
      if (stored) {
        setSavedHost(stored);
        setShowForm(false);
        connectPocket(normalizeHost(stored), null, savedToken);
      } else {
        setShowForm(true);
      }
      setReady(true);
    })();
    return () => disconnectPocket();
  }, []);

  async function onConnect() {
    setError('');
    if (!host.trim() || !token.trim()) return;
    setConnecting(true);
    const url = normalizeHost(host);
    await saveConnection(url, null); // remember host even if pairing fails
    setSavedHost(url);
    connectPocket(url, token.trim(), null);
    // Pairing "succeeds" when auth.ok arrives (status flips to connected).
    setConnecting(false);
    setShowForm(false);
  }

  async function onForget() {
    disconnectPocket();
    await forgetConnection();
    setSavedHost(null);
    setHost('');
    setToken('');
    setShowForm(true);
  }

  if (!ready) {
    return (
      <SafeView
        scrollable={false}
        safeAreaStyle={{ backgroundColor: theme.colors.background }}
        containerClassNames="flex-1 justify-center items-center">
        <ActivityIndicator size="large" />
      </SafeView>
    );
  }

  return (
    <SafeView
      scrollable={false}
      safeAreaClassNames="pt-[21px]"
      safeAreaStyle={{ backgroundColor: theme.colors.background }}
      // Without flex-1 the inner container auto-sizes; flex:1 children then
      // collapse to 0px and the screen renders blank on device.
      containerClassNames="flex-1">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}>
        {/* Status chip — tap to expand/collapse the connection panel */}
        <TouchableOpacity
          onPress={() => setPanelOpen(v => !v)}
          className="px-[30px] pb-2 flex-row items-center"
          hitSlop={4}>
          {status === 'connecting' ? (
            <ActivityIndicator size="small" color={theme.colors.secondary} />
          ) : null}
          <Text
            style={{ color: connected ? theme.colors.secondary : theme.colors.textSecondary }}
            className="flex-1"
            numberOfLines={1}>
            {connected
              ? '✅ ' + t('pocket.status.connected')
              : status === 'connecting'
                ? t('pocket.status.connecting')
                : '⚠ ' + t('pocket.status.offline')}
          </Text>
        </TouchableOpacity>

        {/* Connection panel — always open while not connected */}
        {panelVisible && (
          <View
            className="mx-[30px] mb-2 rounded-xl p-3"
            style={{
              gap: 10,
              backgroundColor: theme.colors.surfaceContainer,
              borderWidth: 1,
              borderColor: connected
                ? theme.colors.surfaceContainerHighest
                : status === 'connecting'
                  ? theme.colors.secondary
                  : theme.colors.error,
            }}>
            {connected ? (
              <>
                <Text style={{ color: theme.colors.text }} numberOfLines={1}>
                  {t('pocket.connection.host', { host: savedHost ?? '' })}
                </Text>
                <View className="flex-row justify-end" style={{ gap: 12 }}>
                  <TouchableOpacity
                    onPress={() => setShowForm(true)}
                    className="px-3 py-2 rounded-lg"
                    style={{ backgroundColor: theme.colors.surfaceContainerHighest }}>
                    <Text style={{ color: theme.colors.text }}>
                      {t('pocket.pairing.repair')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => void onForget()}
                    className="px-3 py-2 rounded-lg"
                    style={{ backgroundColor: theme.colors.error }}>
                    <Text style={{ color: '#FFFFFF' }}>{t('pocket.pairing.forget')}</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : status === 'connecting' && savedHost && !showForm ? (
              <View className="flex-row items-center" style={{ gap: 10 }}>
                <ActivityIndicator size="small" color={theme.colors.secondary} />
                <Text style={{ color: theme.colors.text, flex: 1 }}>
                  {t('pocket.status.connecting_to_server')}
                </Text>
              </View>
            ) : status === 'disconnected' && savedHost && !showForm ? (
              <>
                <Text style={{ color: theme.colors.error, flex: 1 }}>
                  {t('pocket.status.unreachable')}
                </Text>
                <View className="flex-row justify-end" style={{ gap: 12 }}>
                  <TouchableOpacity
                    onPress={() => setShowForm(true)}
                    className="px-3 py-2 rounded-lg"
                    style={{ backgroundColor: theme.colors.surfaceContainerHighest }}>
                    <Text style={{ color: theme.colors.text }}>
                      {t('pocket.status.change_server')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => reconnectPocket()}
                    className="px-3 py-2 rounded-lg"
                    style={{ backgroundColor: theme.colors.secondary }}>
                    <Text style={{ color: '#FFFFFF' }}>{t('pocket.status.retry')}</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <View className="px-1" style={{ gap: 12 }}>
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
                  className="rounded-lg py-3 items-center"
                  style={{ backgroundColor: '#3B82F6' }}>
                  <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '500' }}>
                    {t('pocket.pairing.connect')}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* Chat area — always rendered, every state has a visible outcome */}
        <ChatBody />
        <View style={{ height: insets.bottom }} />
      </KeyboardAvoidingView>
    </SafeView>
  );
}
