/**
 * AnythingPocket M3 — Settings > Routing & Compute (spec §4.4).
 * Optional step after pairing (openable from Settings anytime). Every option
 * carries a one-line consequence explanation (AGENTS.md §4.7: copy first).
 * Manual (default): the phone pins `runtime` per turn.request; Smart: the
 * server router decides and the phone only renders route.decided.
 */
import React, { useEffect, useState } from 'react';
import { ScrollView, ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { ArrowLeft } from 'phosphor-react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SafeView from '@/components/SafeView';
import useHighjackBackButtonPress from '@/hooks/useHighjackBackButtonPress';
import useTheme from '@/hooks/useTheme';
import {
  loadRoutingPrefs,
  saveRoutingPrefs,
  type LightCompute,
  type FallbackPolicy,
  type RoutingMode,
  type RoutingPrefs,
  type Runtime,
} from '@/services/pocket/routingPrefs';
import { loadCertFp } from '@/services/pocket/tokenStore';
import type { IWorkspacePageKey } from '../index';

interface PocketRoutingProps {
  goToPage: (page: IWorkspacePageKey) => void;
}

function OptionRow<T extends string>({
  value,
  label,
  hint,
  selected,
  theme,
  onSelect,
}: {
  value: T;
  label: string;
  hint: string;
  selected: boolean;
  theme: ReturnType<typeof useTheme>;
  onSelect: (v: T) => void;
}) {
  return (
    <TouchableOpacity
      onPress={() => onSelect(value)}
      className="rounded-xl px-4 py-3"
      style={{
        gap: 4,
        backgroundColor: selected ? theme.colors.surfaceContainerHighest : theme.colors.surfaceContainer,
        borderWidth: 1,
        borderColor: selected ? theme.colors.secondary : theme.colors.surfaceContainer,
      }}>
      <Text style={{ color: theme.colors.text, fontWeight: '500' }}>{label}</Text>
      <Text style={{ color: theme.colors.textSecondary }}>{hint}</Text>
    </TouchableOpacity>
  );
}

export default function PocketRouting({ goToPage }: PocketRoutingProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [prefs, setPrefs] = useState<RoutingPrefs | null>(null);
  const [certFp, setCertFp] = useState<string | null>(null);

  useEffect(() => {
    void loadRoutingPrefs().then(setPrefs);
    void loadCertFp().then(setCertFp);
  }, []);

  useHighjackBackButtonPress(() => {
    goToPage('main');
    return true;
  });

  async function update(patch: Partial<RoutingPrefs>) {
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    await saveRoutingPrefs(next);
  }

  if (!prefs) {
    return (
      <SafeView
        safeAreaClassNames="pt-[21px]"
        safeAreaStyle={{ backgroundColor: theme.colors.background }}
        containerClassNames="flex-1 justify-center items-center">
        <ActivityIndicator size="large" />
      </SafeView>
    );
  }

  const modeOptions: { value: RoutingMode; label: string; hint: string }[] = [
    {
      value: 'manual',
      label: t('pocket.routing.mode_manual'),
      hint: t('pocket.routing.mode_manual_hint'),
    },
    {
      value: 'smart',
      label: t('pocket.routing.mode_smart'),
      hint: t('pocket.routing.mode_smart_hint'),
    },
  ];
  const runtimeOptions: { value: Runtime; label: string; hint: string }[] = [
    {
      value: 'lite',
      label: t('pocket.routing.runtime_lite'),
      hint: t('pocket.routing.runtime_lite_hint'),
    },
    {
      value: 'full',
      label: t('pocket.routing.runtime_full'),
      hint: t('pocket.routing.runtime_full_hint'),
    },
  ];
  const lightOptions: { value: LightCompute; label: string; hint: string }[] = [
    {
      value: 'on-device',
      label: t('pocket.routing.light_on_device'),
      hint: t('pocket.routing.light_on_device_hint'),
    },
    {
      value: 'server',
      label: t('pocket.routing.light_server'),
      hint: t('pocket.routing.light_server_hint'),
    },
  ];
  const fallbackOptions: { value: FallbackPolicy; label: string; hint: string }[] = [
    {
      value: 'on-device',
      label: t('pocket.routing.fallback_on_device'),
      hint: t('pocket.routing.fallback_on_device_hint'),
    },
    {
      value: 'stop',
      label: t('pocket.routing.fallback_stop'),
      hint: t('pocket.routing.fallback_stop_hint'),
    },
  ];

  return (
    <SafeView
      scrollable
      safeAreaClassNames="pt-[21px]"
      safeAreaStyle={{ backgroundColor: theme.colors.background }}
      containerClassNames="flex-1">
      <View
        style={{ paddingTop: insets.top, paddingBottom: 20 }}
        className="w-full flex-row items-center justify-center relative">
        <TouchableOpacity
          onPress={() => goToPage('main')}
          className="absolute left-0 flex-row items-center gap-2">
          <ArrowLeft size={24} color="#FFF" weight="bold" />
        </TouchableOpacity>
        <Text className="text-white text-lg font-medium">
          {t('pocket.routing.title')}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, gap: 20, paddingBottom: 40 }}>
        <View style={{ gap: 10 }}>
          <Text style={{ color: '#9F9FA0' }} className="text-sm uppercase">
            {t('pocket.routing.mode_label')}
          </Text>
          {modeOptions.map(o => (
            <OptionRow
              key={o.value}
              value={o.value}
              label={o.label}
              hint={o.hint}
              selected={prefs.mode === o.value}
              theme={theme}
              onSelect={v => void update({ mode: v })}
            />
          ))}
        </View>

        {prefs.mode === 'manual' && (
          <View style={{ gap: 10 }}>
            <Text style={{ color: '#9F9FA0' }} className="text-sm uppercase">
              {t('pocket.routing.manual_runtime_label')}
            </Text>
            {runtimeOptions.map(o => (
              <OptionRow
                key={o.value}
                value={o.value}
                label={o.label}
                hint={o.hint}
                selected={prefs.manualRuntime === o.value}
                theme={theme}
                onSelect={v => void update({ manualRuntime: v })}
              />
            ))}
          </View>
        )}

        {prefs.mode === 'smart' && (
          <View style={{ gap: 10 }}>
            <Text style={{ color: '#9F9FA0' }} className="text-sm uppercase">
              {t('pocket.routing.light_compute_label')}
            </Text>
            {lightOptions.map(o => (
              <OptionRow
                key={o.value}
                value={o.value}
                label={o.label}
                hint={o.hint}
                selected={prefs.lightCompute === o.value}
                theme={theme}
                onSelect={v => void update({ lightCompute: v })}
              />
            ))}
          </View>
        )}

        <View style={{ gap: 10 }}>
          <Text style={{ color: '#9F9FA0' }} className="text-sm uppercase">
            {t('pocket.routing.fallback_label')}
          </Text>
          {fallbackOptions.map(o => (
            <OptionRow
              key={o.value}
              value={o.value}
              label={o.label}
              hint={o.hint}
              selected={prefs.fallback === o.value}
              theme={theme}
              onSelect={v => void update({ fallback: v })}
            />
          ))}
        </View>

        <View style={{ gap: 6 }}>
          <Text style={{ color: '#9F9FA0' }} className="text-sm uppercase">
            {t('pocket.routing.cert_label')}
          </Text>
          <Text style={{ color: theme.colors.textSecondary }}>
            {certFp
              ? t('pocket.routing.cert_stored', { fp: certFp })
              : t('pocket.routing.cert_none')}
          </Text>
        </View>
      </ScrollView>
    </SafeView>
  );
}
