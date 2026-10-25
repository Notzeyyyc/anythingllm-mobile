/**
 * Minimal chat: streaming text, compact trace line ("Langkah N — membaca file..."),
 * approval card with countdown (default reject on timeout), cached history.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { observer } from 'mobx-react';
import { useTranslation } from 'react-i18next';
import SafeView from '@/components/SafeView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import pocketChatStore from '@/services/pocket/chatStore';
import {
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
  const insets = useSafeAreaInsets();
  const [input, setInput] = useState('');
  const [showDetails, setShowDetails] = useState(false);
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
    <SafeView scrollable={false} safeAreaClassNames="pt-[21px]">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}>
        {/* Status line — one outcome-oriented label (spec §7.9) */}
        <View className="px-[30px] pb-2 flex-row items-center justify-between">
          <Text className="text-neutral-300 flex-1" numberOfLines={1}>
            {connected
              ? '✅ ' + t('pocket.status.connected')
              : pocketChatStore.status === 'connecting'
                ? t('pocket.status.connecting')
                : t('pocket.status.offline')}
          </Text>
          <TouchableOpacity onPress={onRepair} hitSlop={8}>
            <Text className="text-[#3B82F6] px-2">{t('pocket.pairing.repair')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onUnpair} hitSlop={8}>
            <Text className="text-red-400 px-2">{t('pocket.pairing.forget')}</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          ref={scrollRef}
          className="flex-1"
          contentContainerStyle={{
            paddingHorizontal: 30,
            paddingBottom: insets.bottom + 16,
            gap: 10,
          }}>
          {pocketChatStore.entries.length === 0 && !pocketChatStore.streamingText && (
            <Text className="text-neutral-500 text-center mt-10">
              {t('pocket.chat.empty')}
            </Text>
          )}
          {pocketChatStore.entries.map((entry, i) => (
            <View
              key={i}
              className={
                entry.role === 'user'
                  ? 'self-end bg-[#3B82F6] rounded-2xl px-4 py-2 max-w-[85%]'
                  : 'self-start bg-[#27282A] rounded-2xl px-4 py-2 max-w-[85%]'
              }>
              <Text className={entry.role === 'user' ? 'text-white' : 'text-neutral-100'}>
                {entry.text}
              </Text>
            </View>
          ))}

          {/* Streaming answer + compact trace line */}
          {(pocketChatStore.streamingText || pocketChatStore.lastTrace) && (
            <View className="self-start max-w-[85%]" style={{ gap: 4 }}>
              <Text className="text-neutral-400 text-xs">
                {pocketChatStore.step > 0 &&
                  t('pocket.chat.step', { n: pocketChatStore.step })}
                {pocketChatStore.lastTrace
                  ? ' — ' + t(pocketChatStore.lastTrace.key, { tool: pocketChatStore.lastTrace.tool })
                  : ''}
              </Text>
              {!!pocketChatStore.streamingText && (
                <View className="bg-[#27282A] rounded-2xl px-4 py-2">
                  <Text className="text-neutral-100">{pocketChatStore.streamingText}</Text>
                </View>
              )}
            </View>
          )}

          {/* Approval card */}
          {pocketChatStore.pendingApproval && (
            <View className="self-start bg-[#1B1B1E] border border-amber-500 rounded-2xl p-4 w-full" style={{ gap: 8 }}>
              <Text className="text-white font-medium">{t('pocket.approval.title')}</Text>
              <Text className="text-neutral-300">
                {t('pocket.approval.tool', { tool: pocketChatStore.pendingApproval.tool })}
              </Text>
              {!!pocketChatStore.pendingApproval.path && (
                <Text className="text-neutral-400 text-xs" selectable>
                  {pocketChatStore.pendingApproval.path}
                </Text>
              )}
              {!!pocketChatStore.pendingApproval.contentPreview && (
                <Text className="text-neutral-400 text-xs" numberOfLines={6} selectable>
                  {pocketChatStore.pendingApproval.contentPreview}
                </Text>
              )}
              <Text className="text-amber-400 text-xs">
                {t('pocket.approval.countdown', { s: secondsLeft })}
              </Text>
              <View className="flex-row justify-end" style={{ gap: 12 }}>
                <TouchableOpacity
                  onPress={() =>
                    respondPocketApproval(pocketChatStore.pendingApproval!.approvalId, 'reject')
                  }
                  className="px-4 py-2 rounded-lg bg-[#27282A]">
                  <Text className="text-white">{t('pocket.approval.reject')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() =>
                    respondPocketApproval(pocketChatStore.pendingApproval!.approvalId, 'grant')
                  }
                  className="px-4 py-2 rounded-lg bg-emerald-600">
                  <Text className="text-white font-medium">{t('pocket.approval.grant')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </ScrollView>

        {/* Collapsible technical detail (spec §7.9) */}
        <TouchableOpacity
          className="px-[30px] pb-1"
          onPress={() => setShowDetails(v => !v)}>
          <Text className="text-neutral-500 text-xs">
            {showDetails
              ? t('pocket.details.hide')
              : t('pocket.details.show')}
          </Text>
        </TouchableOpacity>
        {showDetails && (
          <Text className="px-[30px] pb-1 text-neutral-500 text-xs">
            {t('pocket.details.host', {
              status: pocketChatStore.status,
            })}
          </Text>
        )}

        {/* Input */}
        <View
          className="flex-row items-center px-[30px] pt-2 pb-4"
          style={{ paddingBottom: insets.bottom + 16, gap: 8 }}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={t('pocket.chat.input_placeholder')}
            placeholderTextColor="#9F9FA0"
            editable={connected}
            multiline
            className="flex-1 bg-[#27282A] text-white rounded-2xl px-4 py-2 max-h-24"
          />
          <TouchableOpacity
            onPress={send}
            disabled={!connected || !input.trim()}
            className={`rounded-full px-4 py-3 ${connected && input.trim() ? 'bg-[#3B82F6]' : 'bg-[#27282A]'}`}>
            <Text className="text-white">{t('pocket.chat.send')}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeView>
  );
});

export default ChatView;
