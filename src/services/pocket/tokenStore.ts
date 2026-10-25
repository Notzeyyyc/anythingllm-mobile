/**
 * Secrets live in the keychain only (session token, spec §6); the host URL is
 * not a secret and rides in AsyncStorage. Never log token values.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

const KEYCHAIN_SERVICE = 'anythingpocket.sessionToken';
const HOST_KEY = 'pocket.host';

export async function saveConnection(host: string, sessionToken: string | null) {
  await AsyncStorage.setItem(HOST_KEY, host);
  if (sessionToken) {
    await Keychain.setGenericPassword('session', sessionToken, {
      service: KEYCHAIN_SERVICE,
    });
  }
}

/** Returns the last host, or null. */
export async function loadHost(): Promise<string | null> {
  return AsyncStorage.getItem(HOST_KEY);
}

/** Returns the stored session token (hbs_), or null when absent/unavailable. */
export async function loadSessionToken(): Promise<string | null> {
  try {
    const creds = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
    return creds ? creds.password : null;
  } catch {
    // Keychain can be unavailable on some devices/emulators — treat as signed out.
    return null;
  }
}

/** Clears the session token (does not clear the saved host). */
export async function clearSessionToken() {
  try {
    await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
  } catch {}
}

/** Clears everything (host + token) — "forget this server". */
export async function forgetConnection() {
  await AsyncStorage.removeItem(HOST_KEY);
  await clearSessionToken();
}
