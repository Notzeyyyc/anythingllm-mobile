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
import { observer } from 'mobx-react';
import { reaction } from 'mobx';
import SafeView from '@/components/SafeView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  confirmCertFp,
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

/**
 * Normalize what the user typed into a ws(s):// URL (M1: plain ws, Tailscale/LAN).
 * Accepts bare host, host:port, and ws(s):// or http(s):// forms. Returns null
 * when nothing usable remains (caller shows a validation error instead of
 * silently building `ws://https://…`).
 */
export function normalizeHost(input: string): string | null {
  let host = input.trim();
  host = host.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  if (!/^wss?:\/\//i.test(host)) host = `ws://${host}`;
  host = host.replace(/^(wss?:\/\/[^/]+)\/.*$/i, '$1'); // strip a pasted path, keep scheme://authority
  // host[:port] only; nothing usable → null (caller shows a validation error)
  const m = host.match(/^(wss?):\/\/([^/:?#]+)(?::(\d+))?$/i);
  if (!m || !m[2]) return null;
  return `${m[1].toLowerCase()}://${m[2]}${m[3] ? ':' + m[3] : ':7443'}/ws`;
}

function Pocket() {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [ready, setReady] = useState(false); // finished checking saved host
  const [savedHost, setSavedHost] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false); // manual toggle when connected
  const [error, setError] = useState('');

  const status = pocketChatStore.status;
  const authError = pocketChatStore.authError;
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
        const url = normalizeHost(stored);
        if (url) {
          setSavedHost(url);
          setShowForm(false);
          connectPocket(url, null, savedToken);
        } else {
          setShowForm(true);
        }
      } else {
        setShowForm(true);
      }
      setReady(true);
    })();
    return () => disconnectPocket();
  }, []);

  async function onConnect() {
    setError('');
    pocketChatStore.setAuthError(false);
    if (!host.trim() || !token.trim()) {
      setError(t('pocket.connection.empty_fields'));
      return;
    }
    const url = normalizeHost(host);
    if (!url) {
      setError(t('pocket.connection.invalid_host'));
      return;
    }
    await saveConnection(url, null); // remember host even if pairing fails
    setSavedHost(url);
    connectPocket(url, token.trim(), null);
    // Pairing "succeeds" when auth.ok arrives (status flips to connected).
    setShowForm(false);
  }

  async function onForget() {
    disconnectPocket();
    pocketChatStore.setAuthError(false);
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
            {/* Instant feedback when the sidecar rejects the token (auth.deny) —
                no more silent 6x backoff before "unreachable". */}
            {authError && !connected && (
              <Text style={{ color: theme.colors.error }}>
                {t('pocket.connection.auth_failed')}
              </Text>
            )}
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
                  disabled={!host.trim() || !token.trim()}
                  className="rounded-lg py-3 items-center"
                  style={{
                    backgroundColor:
                      host.trim() && token.trim() ? '#3B82F6' : theme.colors.surfaceContainerHighest,
                  }}>
                  <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '500' }}>
                    {t('pocket.pairing.connect')}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* M3 TOFU verify-twice (spec §6): first sight of the server cert
            fingerprint → user confirms against the server's own screen. */}
        {(pocketChatStore.pendingCertFp || pocketChatStore.certMismatch) && (
          <View
            className="mx-[30px] mb-2 rounded-xl p-3"
            style={{
              gap: 8,
              backgroundColor: theme.colors.surfaceContainer,
              borderWidth: 1,
              borderColor: pocketChatStore.certMismatch
                ? theme.colors.error
                : theme.colors.secondary,
            }}>
            {pocketChatStore.certMismatch && (
              <Text style={{ color: theme.colors.error }}>
                {t('pocket.routing.cert_mismatch_warn')}
              </Text>
            )}
            <Text style={{ color: theme.colors.text }} selectable>
              {pocketChatStore.pendingCertFp}
            </Text>
            <Text style={{ color: theme.colors.textSecondary }}>
              {t('pocket.routing.cert_pending')}
            </Text>
            <View className="flex-row justify-end" style={{ gap: 12 }}>
              <TouchableOpacity
                onPress={() => pocketChatStore.setPendingCertFp(null)}
                className="px-3 py-2 rounded-lg"
                style={{ backgroundColor: theme.colors.surfaceContainerHighest }}>
                <Text style={{ color: theme.colors.text }}>
                  {t('pocket.routing.cert_mismatch')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  const fp = pocketChatStore.pendingCertFp;
                  if (fp) void confirmCertFp(fp);
                }}
                className="px-3 py-2 rounded-lg"
                style={{ backgroundColor: theme.colors.secondary }}>
                <Text style={{ color: '#FFFFFF' }}>
                  {t('pocket.routing.cert_match')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Chat area — always rendered, every state has a visible outcome */}
        <ChatBody />
        <View style={{ height: insets.bottom }} />
      </KeyboardAvoidingView>
    </SafeView>
  );
}

// MobX observer: the chip/panel react to pocketChatStore.status and authError
// without manual state mirrors (the old dead `connecting` state is gone).
export default observer(Pocket);
