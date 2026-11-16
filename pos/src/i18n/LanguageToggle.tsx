import { useEffect } from "react";
import i18next from "i18next";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { LANG_STORAGE_KEY, setAppLanguage, type AppLanguage } from "@/i18n/language.js";
import { setActiveFormatLocale } from "@/lib/format.js";
import "@/i18n/index.js";

const LANGUAGES: { value: AppLanguage; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "bn", label: "বাংলা" },
];

/**
 * Cross-tab language sync: another tab changed ezpos.lang. The native
 * `storage` event fires only in *other* tabs, mirroring the
 * useCfdDisplayIds precedent on PosPage.
 */
export function useCrossTabLanguage(): void {
  useEffect(() => {
    const onChange = (event: StorageEvent) => {
      if (event.key !== LANG_STORAGE_KEY) return;
      if (event.newValue === "en" || event.newValue === "bn") {
        const language = event.newValue;
        void i18next
          .changeLanguage(language)
          .then(() => setActiveFormatLocale(language));
      }
    };
    window.addEventListener("storage", onChange);
    return () => window.removeEventListener("storage", onChange);
  }, []);
}

/** EN / বাংলা switch for the POS topbar. Applies immediately, no reload. */
export function LanguageToggle() {
  useCrossTabLanguage();
  const { i18n, t } = useTranslation();
  const active: AppLanguage = i18n.language === "bn" ? "bn" : "en";
  return (
    <div
      className="flex items-center overflow-hidden rounded-md border"
      role="group"
      aria-label={t("common:language", { defaultValue: "Language" })}
    >
      {LANGUAGES.map(({ value, label }) => (
        <Button
          key={value}
          type="button"
          variant={active === value ? "default" : "ghost"}
          size="sm"
          className="h-7 rounded-none px-2 text-xs"
          aria-pressed={active === value}
          onClick={() => void setAppLanguage(value)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
