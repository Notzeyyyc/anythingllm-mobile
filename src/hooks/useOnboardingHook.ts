import uiStore from "@/store/UIStore";
import Workspace from "@/database/models/Workspace";
import { useEffect, useState } from "react";
import { PATHS } from "@/utils/paths";
import i18n from "@/i18n";
import Telemetry from "@/utils/Telemetry";

/** Storage flag marking onboarding fully done (kept from upstream so legacy
 * installs and every existing reader — useInitialRoute, AssistantApp, etc. —
 * keep working without migration). */
export const ONBOARDING_DONE_FLAG = 'onboarding_data_handling_completed';

/**
 * Pure decision for which route the app should open at launch (unit-tested).
 * New flow: Welcome -> "Mau pakai gimana?" (server pairing / on-device) and
 * either path ends in a workspace, so one final flag decides everything.
 */
export function nextOnboardingRoute(flags: { welcomeCompleted: boolean; onboardingCompleted: boolean }): string {
    if (!flags.welcomeCompleted) return PATHS.onboarding.welcome;
    if (!flags.onboardingCompleted) return PATHS.onboarding.mode_selection;
    return PATHS.home;
}

/**
 * Mark onboarding as finished from any of the new flow's exits (server pairing
 * succeeded, model selection finished, or skipped). Creates the default
 * workspace the rest of the app expects (moved from the removed DataHandling
 * screen), then notifies the navigator the same way upstream did.
 */
export async function completeOnboarding(): Promise<void> {
    if (!(await Workspace.first())) {
        await Workspace.create({ name: i18n.t('onboarding.completion.default_workspace_name') });
    }
    await uiStore.setToStorage(ONBOARDING_DONE_FLAG, true);
    uiStore.emitGlobalEvent(uiStore.globalEvents.ONBOARDING_COMPLETED);
    Telemetry.logEvent(Telemetry.CUSTOM_EVENTS.ONBOARDING.COMPLETED);
}

let repairing: Promise<void> | null = null;

/**
 * The navigator used to treat onboarding as done once its first step was, so quitting partway through dropped the
 * user into the app with the last step never recorded - and the assistant, Quick Actions, sharing and deep links
 * kept asking them to finish setup. Anyone who already has a workspace finished the old flow: record the remaining
 * steps as done. Everyone else resumes onboarding.
 * Runs once per launch; both launch hooks await it before reading the onboarding flags.
 */
export function repairPartialOnboarding(): Promise<void> {
    if (!repairing) repairing = (async () => {
        const welcomeCompleted = await uiStore.getFromStorage('onboarding_welcome_completed', false);
        const onboardingCompleted = await uiStore.getFromStorage(ONBOARDING_DONE_FLAG, false);
        if (!welcomeCompleted || onboardingCompleted) return;
        if (!(await Workspace.first())) return;
        await Promise.all([
            uiStore.setToStorage('onboarding_model_selection_completed', true),
            uiStore.setToStorage('onboarding_survey_completed', true),
            uiStore.setToStorage(ONBOARDING_DONE_FLAG, true),
        ]);
    })().catch((e) => console.error('[Onboarding] could not repair partial onboarding', e));
    return repairing;
}

/**
 * Hook to check if the onboarding is completed
 * Note: this will also listen for the ONBOARDING_COMPLETED event and update the onboardingCompleted state
 * so that we remove the onboarding screens from the navigation stack when no longer needed
 */
export function useOnboardingCompleted(): {
    /**
     * Whether the onboarding is still loading
     */
    loadingOnboardingCompleted: boolean,
    /**
     * Whether the onboarding is completed
     */
    onboardingCompleted: boolean,
} {
    const [loading, setLoading] = useState(true);
    const [onboardingCompleted, setOnboardingCompleted] = useState(false);
    useEffect(() => {
        // The final flag, not the first: until it is recorded the onboarding screens must stay in the navigator,
        // or a relaunch mid-onboarding would land on Home with setup never finished.
        repairPartialOnboarding()
            .then(() => uiStore.getFromStorage(ONBOARDING_DONE_FLAG, false))
            .then(isOnboardingCompleted => setOnboardingCompleted(isOnboardingCompleted))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        const onCompleted = () => setOnboardingCompleted(true);
        const onReset = () => setOnboardingCompleted(false);
        const completedSub = uiStore.emitter.addListener(uiStore.globalEvents.ONBOARDING_COMPLETED, onCompleted);
        const resetSub = uiStore.emitter.addListener(uiStore.globalEvents.ONBOARDING_RESET, onReset);
        // Remove only this hook instance's subscriptions so other mounted
        // consumers (e.g. the root navigator) keep receiving these events.
        return () => {
            completedSub.remove();
            resetSub.remove();
        };
    }, []);
    return { loadingOnboardingCompleted: loading, onboardingCompleted };
}
