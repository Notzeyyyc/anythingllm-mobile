/**
 * AnythingPocket onboarding step 2 (spec §7.9 — outcome-oriented bilingual copy,
 * written before this UI). Two big paths, upstream card styling:
 *  - server pairing -> reuses the existing Pocket screen (no duplication)
 *  - on-device only -> the upstream ModelSelection screen
 * A small skip ends onboarding with the on-device default; pairing can be
 * done later from Settings.
 */
import React from "react";
import { ImageBackground, Linking, Text, TouchableOpacity, View } from "react-native";
import SafeView from "@/components/SafeView";
import { NavigationProp, useNavigation } from "@react-navigation/native";
import { PATHS } from "@/utils/paths";
import { completeOnboarding } from "@/hooks/useOnboardingHook";
import useTheme from "@/hooks/useTheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";

export default function OnboardingModeSelection() {
  const { t } = useTranslation();
  const navigation = useNavigation<NavigationProp<any>>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  // Skip: default to on-device; pairing stays available later from Settings.
  const onSkip = async () => {
    await completeOnboarding();
    navigation.navigate(PATHS.home as never);
  };

  return (
    <React.Fragment>
      <ImageBackground
        source={require("@/assets/onboarding/bg-blobs.png")}
        style={{ backgroundColor: "#131314", position: "absolute", top: 0, left: 0, width: "100%", height: "100%", zIndex: 0 }}
      />
      <SafeView safeAreaClassNames="bg-transparent" containerClassNames="grow z-[1] justify-center" containerStyle={{ paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }}>
        <View className="flex flex-col gap-y-6 items-center px-4">
          <Text className="text-white text-4xl font-bold text-center">{t('onboarding.mode_selection.title')}</Text>

          <ModeCard
            title={t('onboarding.mode_selection.server_title')}
            description={t('onboarding.mode_selection.server_description')}
            onPress={() => navigation.navigate(PATHS.pocket as never)}
          />
          <ModeCard
            title={t('onboarding.mode_selection.ondevice_title')}
            description={t('onboarding.mode_selection.ondevice_description')}
            onPress={() => navigation.navigate(PATHS.onboarding.model_selection as never)}
          />

          <TouchableOpacity onPress={onSkip} className="py-3">
            {/* Inline style, NOT a CSS-var class (text-[--primary-text]) — the
                CSS-var class rendered invisible text twice (commit 1fc1cae). */}
            <Text style={{ color: theme.colors.text }} className="text-lg underline">{t('onboarding.mode_selection.skip')}</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => Linking.openURL(PATHS.upstream_repo)}>
            <Text className="text-white/50 text-xs text-center">
              {t('onboarding.completion.fork_credit')}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeView>
    </React.Fragment>
  );
}

function ModeCard({ title, description, onPress }: { title: string; description: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      style={{ width: '90%', maxWidth: 380, padding: 17, backgroundColor: 'rgba(255,255,255, 0.08)' }}
      className="flex flex-col rounded-lg gap-y-1"
    >
      <Text className="text-white text-xl font-bold">{title}</Text>
      <Text className="text-white/60 text-sm">{description}</Text>
    </TouchableOpacity>
  );
}
