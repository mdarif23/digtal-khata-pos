import { beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";

import { initI18n } from "../index.js";
import { getStoredLanguage, LANG_STORAGE_KEY, setAppLanguage } from "../language.js";

describe("i18n initialization (Phase 5)", () => {
  beforeEach(async () => {
    localStorage.clear();
    initI18n();
    await i18next.changeLanguage("en");
  });

  it("initializes with en and the common namespace", () => {
    expect(i18next.language).toBe("en");
    expect(i18next.t("common:cancel")).toBe("Cancel");
  });

  it("honors a stored bn preference when initialized", async () => {
    localStorage.setItem(LANG_STORAGE_KEY, "bn");
    initI18n();
    // init resolves asynchronously; poll until the instance settles
    await vi.waitFor(() => {
      if (i18next.language !== "bn") throw new Error("stored language not applied yet");
    });
    expect(i18next.language).toBe("bn");
  });

  it("falls back to en for keys missing in bn", async () => {
    i18next.addResourceBundle("en", "common", { onlyEnglish: "English only" });
    await i18next.changeLanguage("bn");
    expect(i18next.t("common:onlyEnglish")).toBe("English only");
  });

  it("returns the defaultValue for keys missing everywhere", () => {
    expect(i18next.t("common:definitely_missing_key", { defaultValue: "English fallback" })).toBe(
      "English fallback",
    );
  });

  it("persists a language switch and applies it live", async () => {
    await setAppLanguage("bn");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("bn");
    expect(i18next.language).toBe("bn");
    expect(i18next.t("common:cancel")).toBe("বাতিল");
    await setAppLanguage("en");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("en");
    expect(i18next.t("common:cancel")).toBe("Cancel");
  });

  it("getStoredLanguage reads the persisted choice and defaults to en", () => {
    localStorage.removeItem(LANG_STORAGE_KEY);
    expect(getStoredLanguage()).toBe("en");
    localStorage.setItem(LANG_STORAGE_KEY, "bn");
    expect(getStoredLanguage()).toBe("bn");
  });
});
