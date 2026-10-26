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
import pocketChatStore from './chatStore';
import { loadSessionToken, saveConnection } from './tokenStore';

let connection: PocketConnection | null = null;
/** Last connect args so "Coba lagi" can retry without re-pairing. */
let lastUrl: string | null = null;
let lastSessionToken: string | null = null;

export function connectPocket(
  url: string,
  pairingToken: string | null,
  sessionToken: string | null,
) {
  disconnectPocket();
  lastUrl = url;
  lastSessionToken = sessionToken;
  pocketChatStore.setStatus('connecting');
  const handlers: PocketHandlers = {
    onStatusChange: (s: PocketStatus) => pocketChatStore.setStatus(s),
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
    onError: () => {
      /* status banner covers it; keep tokens out of any log */
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

export function sendPocketTurn(prompt: string): boolean {
  if (!connection || !connection.isReady()) return false;
  const turnId = connection.sendTurn(prompt);
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
  connection?.disconnect();
  connection = null;
  pocketChatStore.setStatus('disconnected');
}

/** Load the saved session token (used to decide reconnect vs re-pair). */
export { loadSessionToken };
