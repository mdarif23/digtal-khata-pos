import i18next from "i18next";

export type AppLanguage = "en" | "bn";

/**
 * Persisted at the ezpos.* dotted-style key (matches ezpos.cfd.* conventions).
 * Cross-tab reactivity relies on the native `storage` event, which fires in
 * every *other* tab when this key is written (useCfdDisplayIds precedent).
 */
export const LANG_STORAGE_KEY = "ezpos.lang";

export function getStoredLanguage(): AppLanguage {
  try {
    return localStorage.getItem(LANG_STORAGE_KEY) === "bn" ? "bn" : "en";
  } catch {
    return "en"; // storage unavailable (private mode, test envs) — EN default
  }
}

export function storeLanguage(lang: AppLanguage): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // ignore — the language still applies for this session
  }
}

/** Switch the live i18n instance and persist the choice. */
export async function setAppLanguage(lang: AppLanguage): Promise<void> {
  await i18next.changeLanguage(lang);
  storeLanguage(lang);
}
