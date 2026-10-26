/**
 * Trace viewer level 2 (Detail) + level 3 (Raw/"mode belajar") — spec §7.1.
 * Bottom-sheet style modal: one step's tool, available payload fields (the
 * server sends argsHash, not raw args — show what we have), ok/fail, duration;
 * with pocket.rawMode ON, a "Raw JSON" tab shows the events exactly as received.
 */
import React, { useState } from 'react';
import { Modal, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { observer } from 'mobx-react';
import pocketChatStore from '@/services/pocket/chatStore';
import { stepDetails } from '@/services/pocket/chatStore';
import type { TraceEvent } from '@/services/pocket/PocketConnection';

function PayloadLines({ ev }: { ev: TraceEvent }) {
  return (
    <>
      {Object.entries(ev.payload ?? {}).map(([k, v]) => (
        <Text key={k} className="text-neutral-300 text-xs" selectable>
          {k}: {String(v)}
        </Text>
      ))}
    </>
  );
}

const TraceDetailModal = observer(function TraceDetailModal({
  entryIndex,
  stepIndex,
  onClose,
}: {
  entryIndex: number;
  stepIndex: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [showRaw, setShowRaw] = useState(false);
  const entry = pocketChatStore.entries[entryIndex];
  const details = stepDetails(entry?.events ?? []);
  const detail = details[stepIndex];

  if (!detail) return null;

  const ok = detail.end?.payload?.ok;
  const duration = detail.end?.payload?.durationMs;

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/60">
        <View className="bg-[#1B1B1E] rounded-t-2xl p-4" style={{ maxHeight: '75%', gap: 8 }}>
          <TouchableOpacity onPress={onClose} hitSlop={8} className="self-end">
            <Text className="text-neutral-400">✕</Text>
          </TouchableOpacity>
          <Text className="text-white font-medium">
            {t('pocket.trace.step_item', {
              n: stepIndex + 1,
              label: t(detail.key, { tool: detail.tool }),
            })}
          </Text>
          {pocketChatStore.rawMode && (
            <TouchableOpacity onPress={() => setShowRaw(v => !v)}>
              <Text className="text-[#3B82F6] text-xs">
                {showRaw ? t('pocket.trace.detail_tab') : t('pocket.trace.raw_tab')}
              </Text>
            </TouchableOpacity>
          )}
          {showRaw ? (
            <ScrollView>
              <Text className="text-neutral-400 text-xs font-mono" selectable>
                {JSON.stringify([detail.start, ...(detail.end ? [detail.end] : [])], null, 2)}
              </Text>
            </ScrollView>
          ) : (
            <ScrollView style={{ gap: 4 }}>
              <PayloadLines ev={detail.start} />
              {detail.end ? (
                <>
                  <PayloadLines ev={detail.end} />
                  <Text className={ok ? 'text-emerald-400 text-xs' : 'text-red-400 text-xs'}>
                    {ok
                      ? t('pocket.trace.result_ok', { ms: String(duration ?? '') })
                      : t('pocket.trace.result_fail')}
                  </Text>
                </>
              ) : (
                <Text className="text-neutral-500 text-xs">{t('pocket.trace.result_pending')}</Text>
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
});

export default TraceDetailModal;
