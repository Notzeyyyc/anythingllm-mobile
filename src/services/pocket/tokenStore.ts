/**
 * Secrets live in the keychain only (session token, spec §6); the host URL is
 * not a secret and rides in AsyncStorage. Never log token values.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

const KEYCHAIN_SERVICE = 'anythingpocket.sessionToken';
const HOST_KEY = 'pocket.host';
/** TOFU-verified cert fingerprint (M3) — not a secret, AsyncStorage is fine. */
const CERT_FP_KEY = 'pocket.certFp';

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

/** Returns the TOFU-verified cert fingerprint, or null. */
export async function loadCertFp(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(CERT_FP_KEY);
  } catch {
    return null;
  }
}

/** Persist the fingerprint the user confirmed against the server screen. */
export async function saveCertFp(fp: string): Promise<void> {
  await AsyncStorage.setItem(CERT_FP_KEY, fp);
}

/** Clears everything (host + token) — "forget this server". */
export async function forgetConnection() {
  await AsyncStorage.removeItem(HOST_KEY);
  await AsyncStorage.removeItem(CERT_FP_KEY);
  await clearSessionToken();
}
