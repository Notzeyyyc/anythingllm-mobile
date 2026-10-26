/**
 * One live PocketConnection for the app, wired to the chat store. Session
 * tokens issued by auth.ok are stored via the keychain-backed token store
 * and reused for every reconnect (spec §5.3).
 */
import {
  PocketConnection,
  type ApprovalRequest,
  type PocketHandlers,
  type PocketStatus,
  type TraceEvent,
  type TurnEnd,
} from './PocketConnection';
import { loadRoutingPrefs, shouldFallbackOnDevice } from './routingPrefs';
import { normalizeFp } from './challenge';
import {
  loadCertFp,
  loadSessionToken,
  saveCertFp,
  saveConnection,
} from './tokenStore';
import pocketChatStore from './chatStore';

let connection: PocketConnection | null = null;
/** Last connect args so "Coba lagi" can retry without re-pairing. */
let lastUrl: string | null = null;
let lastSessionToken: string | null = null;
/** TOFU-verified cert fingerprint for the challenge (null = not verified yet). */
let certFp: string | null = null;
/** Background retry handle while offline-fallback is active (spec §7.8). */
let bgRetryHandle: ReturnType<typeof setTimeout> | null = null;

/** User confirmed the fingerprint matches the server screen (TOFU 2nd view). */
export async function confirmCertFp(fp: string) {
  certFp = fp;
  await saveCertFp(fp);
  pocketChatStore.setPendingCertFp(null);
  pocketChatStore.setCertMismatch(false);
}

/**
 * Hybrid fallback (spec §7.8): when the connection gave up and the policy
 * allows on-device, keep a slow background retry loop while the user chats
 * with the on-device model. History is untouched (read-only cache).
 */
function scheduleBackgroundRetry() {
  if (bgRetryHandle) return;
  void (async () => {
    const prefs = await loadRoutingPrefs();
    if (!shouldFallbackOnDevice(prefs, pocketChatStore.status)) return;
    bgRetryHandle = setTimeout(() => {
      bgRetryHandle = null;
      if (pocketChatStore.status === 'disconnected') reconnectPocket();
    }, 60_000);
  })();
}

export async function connectPocket(
  url: string,
  pairingToken: string | null,
  sessionToken: string | null,
) {
  disconnectPocket();
  lastUrl = url;
  lastSessionToken = sessionToken;
  certFp = await loadCertFp();
  pocketChatStore.setStatus('connecting');
  pocketChatStore.setAuthError(false);
  const handlers: PocketHandlers = {
    onStatusChange: (s: PocketStatus) => {
      pocketChatStore.setStatus(s);
      if (s === 'disconnected') scheduleBackgroundRetry();
    },
    onSessionStarted: () => {},
    onSessionToken: (token: string) => {
      // Keychain only — never AsyncStorage, never logs (spec §6).
      lastSessionToken = token;
      void saveConnection(url, token);
    },
    onDelta: (turnId: string, delta: string) => pocketChatStore.appendStreaming(delta),
    onTurnEnd: ({ ok, text, error }: TurnEnd) =>
      void pocketChatStore.finishTurn(ok, text, error),
    onApprovalRequest: (req: ApprovalRequest) => pocketChatStore.setApproval(req),
    onTrace: (ev: TraceEvent) => pocketChatStore.onTrace(ev),
    onCertFp: (fp: string) => {
      // TOFU verify-twice (spec §6): first sight → ask the user; known fp that
      // changed → warn; matching → nothing to show.
      if (!certFp) {
        pocketChatStore.setPendingCertFp(fp);
        return;
      }
      pocketChatStore.setCertMismatch(normalizeFp(fp) !== normalizeFp(certFp));
      pocketChatStore.setPendingCertFp(pocketChatStore.certMismatch ? fp : null);
    },
    onError: (message: string) => {
      // auth.deny (bad pairing/session token) → instant banner in the pairing
      // form instead of a silent 6x backoff. Keep tokens out of any log.
      if (/auth/i.test(String(message))) pocketChatStore.setAuthError(true);
    },
  };
  connection = new PocketConnection({
    url,
    pairingToken: pairingToken ?? '',
    sessionToken,
    handlers,
  });
  connection.connect();
}

/**
 * Called by the connection when a fresh session token arrives — kept separate
 * so the keychain write happens exactly once per pairing.
 */
export async function storeSessionToken(url: string, sessionToken: string) {
  await saveConnection(url, sessionToken);
}

/** Retry the last connection after an offline give-up. */
export function reconnectPocket(): boolean {
  if (connection) {
    connection.retry();
    return true;
  }
  if (!lastUrl) return false;
  connectPocket(lastUrl, null, lastSessionToken);
  return true;
}

export function sendPocketTurn(
  prompt: string,
  runtime?: 'lite' | 'full',
): boolean {
  if (!connection || !connection.isReady()) return false;
  const turnId = connection.sendTurn(prompt, runtime);
  return !!turnId;
}

export function respondPocketApproval(
  approvalId: string,
  decision: 'grant' | 'reject',
) {
  connection?.respondApproval(approvalId, decision);
  pocketChatStore.setApproval(null);
}

export function disconnectPocket() {
  if (bgRetryHandle) {
    clearTimeout(bgRetryHandle);
    bgRetryHandle = null;
  }
  connection?.disconnect();
  connection = null;
  pocketChatStore.setStatus('disconnected');
}

/** Load the saved session token (used to decide reconnect vs re-pair). */
export { loadSessionToken };
