/**
 * Minimal chat: streaming text, compact trace line ("Langkah N — membaca file..."),
 * approval card with countdown (default reject on timeout), cached history.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { observer } from 'mobx-react';
import { useTranslation } from 'react-i18next';
import SafeView from '@/components/SafeView';
import useTheme from '@/hooks/useTheme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import pocketChatStore from '@/services/pocket/chatStore';
import { shareTrace } from '@/services/pocket/traceExport';
import TraceDetailModal from './TraceDetailModal';
import {
  reconnectPocket,
  respondPocketApproval,
  sendPocketTurn,
} from '@/services/pocket/connectionSingleton';

const APPROVAL_TICK_MS = 500;

const ChatView = observer(function ChatView({
  onUnpair,
  onRepair,
}: {
  onUnpair: () => void;
  onRepair: () => void;
}) {
  const { t } = useTranslation();
  // Same fix as the pairing screen: read colors from the upstream theme store
  // instead of hardcoded dark hexes (white-on-white on light-scheme devices).
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [input, setInput] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [expandedTrace, setExpandedTrace] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ entry: number; step: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!pocketChatStore.pendingApproval) return;
    const timer = setInterval(() => setNow(Date.now()), APPROVAL_TICK_MS);
    return () => clearInterval(timer);
  }, [pocketChatStore.pendingApproval]);

  const connected = pocketChatStore.status === 'connected';
  const secondsLeft = pocketChatStore.pendingApproval
    ? Math.max(0, Math.ceil((pocketChatStore.pendingApproval.expiresAt - now) / 1000))
    : 0;

  function send() {
    const prompt = input.trim();
    if (!prompt || !connected || !sendPocketTurn(prompt)) return;
    void pocketChatStore.addUserEntry(prompt);
    setInput('');
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }

  return (
    <SafeView
      scrollable={false}
      safeAreaClassNames="pt-[21px]"
      safeAreaStyle={{ backgroundColor: theme.colors.background }}
      // Without flex-1 the inner container auto-sizes; the flex:1
      // KeyboardAvoidingView inside then collapses to 0px and the whole
      // screen renders blank (black) on device.
      containerClassNames="flex-1">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}>
        {/* Status line — one outcome-oriented label (spec §7.9) */}
        <View className="px-[30px] pb-2 flex-row items-center justify-between">
          <Text style={{ color: theme.colors.textSecondary }} className="flex-1" numberOfLines={1}>
            {connected
              ? '✅ ' + t('pocket.status.connected')
              : pocketChatStore.status === 'connecting'
                ? t('pocket.status.connecting')
                : t('pocket.status.offline')}
          </Text>
          <TouchableOpacity onPress={onRepair} hitSlop={8}>
            <Text style={{ color: theme.colors.secondary }} className="px-2">{t('pocket.pairing.repair')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onUnpair} hitSlop={8}>
            <Text style={{ color: theme.colors.error }} className="px-2">{t('pocket.pairing.forget')}</Text>
          </TouchableOpacity>
        </View>

        {/* Connecting / offline banner — the screen must never look dead */}
        {!connected && (
          <View
            className="mx-[30px] mb-2 rounded-xl p-3 flex-row items-center"
            style={{
              gap: 10,
              backgroundColor: theme.colors.surfaceContainer,
              borderWidth: 1,
              borderColor:
                pocketChatStore.status === 'connecting'
                  ? theme.colors.secondary
                  : theme.colors.error,
            }}>
            {pocketChatStore.status === 'connecting' ? (
              <>
                <ActivityIndicator size="small" color={theme.colors.secondary} />
                <Text style={{ color: theme.colors.text, flex: 1 }}>
                  {t('pocket.status.connecting_to_server')}
                </Text>
              </>
            ) : (
              <>
                <Text style={{ color: theme.colors.error, flex: 1 }}>
                  {t('pocket.status.unreachable')}
                </Text>
                <TouchableOpacity
                  onPress={() => reconnectPocket()}
                  className="px-3 py-2 rounded-lg"
                  style={{ backgroundColor: theme.colors.secondary }}>
                  <Text style={{ color: '#FFFFFF' }}>{t('pocket.status.retry')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={onRepair}
                  className="px-3 py-2 rounded-lg"
                  style={{ backgroundColor: theme.colors.surfaceContainerHighest }}>
                  <Text style={{ color: theme.colors.text }}>
                    {t('pocket.status.change_server')}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        <ScrollView
          ref={scrollRef}
          className="flex-1"
          contentContainerStyle={{
            paddingHorizontal: 30,
            paddingBottom: insets.bottom + 16,
            gap: 10,
          }}>
          {pocketChatStore.entries.length === 0 && !pocketChatStore.streamingText && (
            <Text
              style={{ color: theme.colors.textSecondary }}
              className="text-center mt-10">
              {t('pocket.chat.empty')}
            </Text>
          )}
          {pocketChatStore.entries.map((entry, i) => (
            <View
              key={i}
              className="rounded-2xl px-4 py-2 max-w-[85%]"
              style={{
                alignSelf: entry.role === 'user' ? 'flex-end' : 'flex-start',
                backgroundColor:
                  entry.role === 'user' ? '#3B82F6' : theme.colors.surfaceContainerHighest,
              }}>
              <Text
                style={{ color: entry.role === 'user' ? '#FFFFFF' : theme.colors.text }}>
                {entry.text}
              </Text>
              {/* Trace Rangkuman (spec §7.1, M2a) — collapsed one-liner, tap to expand */}
              {entry.role === 'assistant' && entry.trace && (
                <TouchableOpacity
                  onPress={() => setExpandedTrace(expandedTrace === i ? null : i)}>
                  <Text style={{ color: theme.colors.textSecondary }} className="text-xs mt-1">
                    {t('pocket.trace.summary', {
                      steps: entry.trace.steps.length,
                      tools: entry.trace.tools,
                      s: entry.trace.s,
                    })}
                  </Text>
                  {expandedTrace === i &&
                    entry.trace.steps.map((st, j) => (
                      <TouchableOpacity key={j} onPress={() => setDetail({ entry: i, step: j })}>
                        <Text style={{ color: theme.colors.textSecondary }} className="text-xs">
                          {t('pocket.trace.step_item', {
                            n: j + 1,
                            label: t(st.key, { tool: st.tool }),
                          })}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  {expandedTrace === i && (
                    <View className="flex-row" style={{ gap: 12 }}>
                      <TouchableOpacity onPress={() => void shareTrace([entry], 'markdown')}>
                        <Text style={{ color: theme.colors.secondary }} className="text-xs">
                          {t('pocket.trace.export_md')}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => void shareTrace([entry], 'json')}>
                        <Text style={{ color: theme.colors.secondary }} className="text-xs">
                          {t('pocket.trace.export_json')}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </TouchableOpacity>
              )}
            </View>
          ))}

          {/* Streaming answer + compact trace line */}
          {(pocketChatStore.streamingText || pocketChatStore.lastTrace) && (
            <View className="self-start max-w-[85%]" style={{ gap: 4 }}>
              <Text style={{ color: theme.colors.textSecondary }} className="text-xs">
                {pocketChatStore.step > 0 &&
                  t('pocket.chat.step', { n: pocketChatStore.step })}
                {pocketChatStore.lastTrace
                  ? ' — ' + t(pocketChatStore.lastTrace.key, { tool: pocketChatStore.lastTrace.tool })
                  : ''}
              </Text>
              {!!pocketChatStore.streamingText && (
                <View
                  className="rounded-2xl px-4 py-2"
                  style={{ backgroundColor: theme.colors.surfaceContainerHighest }}>
                  <Text style={{ color: theme.colors.text }}>
                    {pocketChatStore.streamingText}
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Approval card */}
          {pocketChatStore.pendingApproval && (
            <View
              className="self-start rounded-2xl p-4 w-full"
              style={{
                gap: 8,
                backgroundColor: theme.colors.surfaceContainer,
                borderWidth: 1,
                borderColor: '#F59E0B',
              }}>
              <Text style={{ color: theme.colors.text, fontWeight: '500' }}>
                {t('pocket.approval.title')}
              </Text>
              <Text style={{ color: theme.colors.textSecondary }}>
                {t('pocket.approval.tool', { tool: pocketChatStore.pendingApproval.tool })}
              </Text>
              {!!pocketChatStore.pendingApproval.path && (
                <Text style={{ color: theme.colors.textSecondary }} className="text-xs" selectable>
                  {pocketChatStore.pendingApproval.path}
                </Text>
              )}
              {!!pocketChatStore.pendingApproval.contentPreview && (
                <Text style={{ color: theme.colors.textSecondary }} className="text-xs" numberOfLines={6} selectable>
                  {pocketChatStore.pendingApproval.contentPreview}
                </Text>
              )}
              <Text style={{ color: '#F59E0B' }} className="text-xs">
                {t('pocket.approval.countdown', { s: secondsLeft })}
              </Text>
              <View className="flex-row justify-end" style={{ gap: 12 }}>
                <TouchableOpacity
                  onPress={() =>
                    respondPocketApproval(pocketChatStore.pendingApproval!.approvalId, 'reject')
                  }
                  className="px-4 py-2 rounded-lg"
                  style={{ backgroundColor: theme.colors.surfaceContainerHighest }}>
                  <Text style={{ color: theme.colors.text }}>
                    {t('pocket.approval.reject')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() =>
                    respondPocketApproval(pocketChatStore.pendingApproval!.approvalId, 'grant')
                  }
                  className="px-4 py-2 rounded-lg" style={{ backgroundColor: '#059669' }}>
                  <Text style={{ color: '#FFFFFF', fontWeight: '500' }}>
                    {t('pocket.approval.grant')}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </ScrollView>

        {/* Collapsible technical detail (spec §7.9) */}
        <TouchableOpacity
          className="px-[30px] pb-1"
          onPress={() => setShowDetails(v => !v)}>
          <Text style={{ color: theme.colors.textSecondary }} className="text-xs">
            {showDetails
              ? t('pocket.details.hide')
              : t('pocket.details.show')}
          </Text>
        </TouchableOpacity>
        {showDetails && (
          <View className="px-[30px] pb-1" style={{ gap: 6 }}>
            <Text style={{ color: theme.colors.textSecondary }} className="text-xs">
              {t('pocket.details.host', {
                status: pocketChatStore.status,
              })}
            </Text>
            {/* Raw / "mode belajar" toggle (spec §7.1 level 3) */}
            <View className="flex-row items-center justify-between">
              <Text style={{ color: theme.colors.textSecondary }} className="text-xs flex-1">
                {t('pocket.settings.raw_mode')}
              </Text>
              <Switch
                value={pocketChatStore.rawMode}
                onValueChange={v => pocketChatStore.setRawMode(v)}
              />
            </View>
          </View>
        )}

        {/* Input */}
        <View
          className="flex-row items-center px-[30px] pt-2 pb-4"
          style={{ paddingBottom: insets.bottom + 16, gap: 8 }}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={t('pocket.chat.input_placeholder')}
            placeholderTextColor={theme.colors.placeholder}
            editable={connected}
            multiline
            className="flex-1 rounded-2xl px-4 py-2 max-h-24"
            style={{
              backgroundColor: theme.colors.surfaceContainerHighest,
              color: theme.colors.text,
            }}
          />
          <TouchableOpacity
            onPress={send}
            disabled={!connected || !input.trim()}
            className="rounded-full px-4 py-3"
            style={{
              backgroundColor: connected && input.trim() ? '#3B82F6' : theme.colors.surfaceContainerHighest,
            }}>
            <Text style={{ color: theme.colors.text }}>{t('pocket.chat.send')}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
      {detail && <TraceDetailModal entryIndex={detail.entry} stepIndex={detail.step} onClose={() => setDetail(null)} />}
    </SafeView>
  );
});

export default ChatView;
