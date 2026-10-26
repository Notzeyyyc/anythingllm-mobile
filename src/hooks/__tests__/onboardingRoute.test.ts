/**
 * Unit tests for the pure onboarding route decision (new flow).
 */
jest.mock('@/store/UIStore', () => ({ __esModule: true, default: { emitter: { addListener: () => ({ remove: () => {} }) }, globalEvents: {}, getFromStorage: jest.fn(), setToStorage: jest.fn(), emitGlobalEvent: jest.fn() } }));
jest.mock('@/database/models/Workspace', () => ({ __esModule: true, default: {} }));
jest.mock('@/i18n', () => ({ __esModule: true, default: { t: (key: string) => key } }));
jest.mock('@/utils/Telemetry', () => ({ __esModule: true, default: { logEvent: jest.fn(), CUSTOM_EVENTS: { ONBOARDING: { COMPLETED: 'onboarding_completed' } } } }));

import { nextOnboardingRoute } from '@/hooks/useOnboardingHook';
import { PATHS } from '@/utils/paths';

describe('nextOnboardingRoute', () => {
  it('opens Welcome for a fresh install', () => {
    expect(nextOnboardingRoute({ welcomeCompleted: false, onboardingCompleted: false }))
      .toBe(PATHS.onboarding.welcome);
  });

  it('opens mode selection after Welcome but before any path completes', () => {
    expect(nextOnboardingRoute({ welcomeCompleted: true, onboardingCompleted: false }))
      .toBe(PATHS.onboarding.mode_selection);
  });

  it('opens Home once onboarding is done (either path)', () => {
    expect(nextOnboardingRoute({ welcomeCompleted: true, onboardingCompleted: true }))
      .toBe(PATHS.home);
  });
});
