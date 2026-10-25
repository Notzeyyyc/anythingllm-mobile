import AsyncStorage from '@react-native-async-storage/async-storage';
import { isDebugMode } from '@/utils/constants';

/** AsyncStorage key holding the (legacy, no-op) telemetry opt-out flag */
const TELEMETRY_ENABLED_KEY = 'anythingllm_telemetry_enabled';

/**
 * AnythingPocket: telemetry to any cloud service is removed (spec final_spec.md §6 —
 * "tidak ada data ke pihak ketiga"). This module keeps the upstream call surface
 * (logEvent / recordError / trackNativeModelLoad / CUSTOM_EVENTS) so the ~40 upstream
 * call sites stay untouched, but every sink is local-only: debug console. Nothing ever
 * leaves the device.
 */
class Telemetry {
    private static instance: Telemetry;

    CUSTOM_EVENTS = {
        ONBOARDING: {
            COMPLETED: 'onboarding_completed',
            SURVEY_RESPONSE: 'onboarding_survey_response',
        },
        ACTIONS: {
            WORKSPACE_CREATED: 'workspace_created',
            CHAT_COMPLETED: 'chat_completed',
            CHAT_ABORTED: 'chat_aborted',
            DOCUMENT_IMPORTED: 'document_added',
            IMAGE_ATTACHED: 'image_attached',
            CONTENT_SHARED: 'content_shared',
            HF_PULL_LINK_OPENED: 'hf_pull_link_opened',
            QUICK_CONTEXT_USED: 'quick_context_used',
            QUICK_CONTEXT_TOGGLED: 'quick_context_toggled',
            ASSISTANT_SETUP_OPENED: 'assistant_setup_opened',
            ASSISTANT_INVOKED: 'assistant_invoked',
            ASSISTANT_CHAT_SENT: 'assistant_chat_sent',
            ASSISTANT_PREFERENCE_TOGGLED: 'assistant_preference_toggled',
            ASSISTANT_THEME_CHANGED: 'assistant_theme_changed',
            TOOL_CALLED: 'tool_called',
            TOOL_ENABLED: 'tool_enabled',
            LLM_SETTINGS_UPDATED: 'llm_settings_updated',
            THREAD_EXPORTED: 'thread_exported',
            THREAD_FORKED: 'thread_forked',
            CHAT_DELETED: 'chat_deleted',
            CHAT_RETRIED: 'chat_retried',
            MEMORIES_ENABLED: 'memories_enabled',
            MEMORY_SAVED: 'memory_saved',
            SCHEDULED_JOB_CREATED: 'scheduled_job_created',
            SCHEDULED_JOB_RAN: 'scheduled_job_ran',
            REMINDER_SET: 'reminder_set',
            HIGHLIGHTS_VIEWED: 'highlights_viewed',
            EXTERNAL_CONNECTION_ESTABLISHED: 'external_connection_established',
            EXTERNAL_WORKSPACE_IMPORTED: 'external_workspace_imported',
        },
        DISABLED_TELEMETRY: 'disabled_telemetry',
    } as const;

    constructor() {
        if (Telemetry.instance) return Telemetry.instance;
        Telemetry.instance = this;
    }

    log(message: any, ...args: any[]) {
        console.log(`\x1b[32m[Telemetry]\x1b[0m`, message, ...args)
    }

    /** Local-only: console in debug builds, dropped entirely in release. */
    logEvent(name: string, params: Record<string, any> = {}) {
        if (isDebugMode) this.log(`Tracking event: ${name}`, params);
    }

    /** Local-only: no crash reporting service. Recovered errors go to console only. */
    recordError(error: Error, context?: string) {
        console.warn('[Telemetry] recovered error', context ?? '', error?.message);
    }

    /**
     * Runs the wrapped native model load unchanged. Crash context reporting was removed
     * with Crashlytics; nothing to stamp before/after the load anymore.
     */
    async trackNativeModelLoad<T>(
        kind: string,
        path: string,
        details: Record<string, string | number | boolean>,
        load: () => Promise<T>,
    ): Promise<T> {
        return load();
    }

    /** Telemetry is permanently off; kept for the legacy Settings toggle. */
    async isEnabled(): Promise<boolean> {
        return false;
    }

    /** Persists the flag so the legacy Settings toggle keeps working. Nothing is collected either way. */
    async setEnabled(enabled: boolean): Promise<void> {
        await AsyncStorage.setItem(TELEMETRY_ENABLED_KEY, String(enabled));
        if (isDebugMode) this.log(`Telemetry flag set to ${enabled} (no-op: no collector exists)`);
    }
}

const telemetry = new Telemetry();
export default telemetry;
