import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import bnCommon from "./locales/bn/common.json";
import bnPayment from "./locales/bn/payment.json";
import bnPos from "./locales/bn/pos.json";
import bnRegister from "./locales/bn/register.json";
import bnSaleSuccess from "./locales/bn/saleSuccess.json";
import enCommon from "./locales/en/common.json";
import enPayment from "./locales/en/payment.json";
import enPos from "./locales/en/pos.json";
import enRegister from "./locales/en/register.json";
import enSaleSuccess from "./locales/en/saleSuccess.json";
import { getStoredLanguage } from "./language.js";
import { setActiveFormatLocale } from "../lib/format.js";

/**
 * Bangla localization (Phase 5).
 *
 * Resources are statically imported so Vite content-hashes them into
 * /assets/* — the PWA service worker's cache-first asset rule then auto-busts
 * translations on every deploy (sw.js v2 is network-first only for
 * navigations). Never fetch translation JSON from an unhashed public/ path:
 * the SW would pin the first-fetched copy forever.
 *
 * No raw key path may ever render — two layers guarantee it:
 *   1. fallbackLng "en" (missing bn keys fall back to the English resource);
 *   2. every t() call passes `defaultValue` equal to the current English
 *      string, so even a key missing from BOTH locales renders English.
 * During extraction passes, temporarily enable `saveMissing` + a
 * missingKeyHandler logger to collect gaps; disable before committing.
 */
export function initI18n(): void {
  void i18next.use(initReactI18next).init({
    resources: {
      en: {
        common: enCommon,
        pos: enPos,
        payment: enPayment,
        saleSuccess: enSaleSuccess,
        register: enRegister,
      },
      bn: {
        common: bnCommon,
        pos: bnPos,
        payment: bnPayment,
        saleSuccess: bnSaleSuccess,
        register: bnRegister,
      },
    },
    lng: getStoredLanguage(),
    fallbackLng: "en",
    defaultNS: "common",
    interpolation: { escapeValue: false }, // React already escapes output
    returnNull: false,
    react: { useSuspense: false }, // dialogs render synchronously — mid-checkout included
  });
  // Date formatters (formatDate/formatDateTime) follow the active language.
  setActiveFormatLocale(getStoredLanguage());
}

initI18n();
