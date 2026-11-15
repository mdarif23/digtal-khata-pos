import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18next from "i18next";

import {
  formatCurrency,
  formatDate,
  formatDateTime,
  setActiveFormatLocale,
} from "../../lib/format.js";
import { setAppLanguage } from "../language.js";
import "../index.js";

describe("locale-aware date formatting (Phase 5)", () => {
  beforeEach(async () => {
    localStorage.clear();
    initToEn();
  });

  afterEach(() => {
    setActiveFormatLocale("en");
  });

  function initToEn() {
    void i18next.changeLanguage("en");
    setActiveFormatLocale("en");
  }

  it("keeps the default (en) output byte-identical to the pre-i18n formatters", () => {
    expect(formatDate("2026-01-15")).toBe("15 Jan 2026");
    expect(formatDateTime("2026-01-15T15:25:00")).toBe(
      "15 Jan 2026, 03:25 PM",
    );
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("renders Bangla month names with Latin digits when the bn locale is set", () => {
    expect(formatDate("2026-01-15", "bn")).toMatch(/15 .*2026/);
    expect(formatDate("2026-01-15", "bn")).toContain("জানু");
    expect(formatDateTime("2026-01-15T15:25:00", "bn")).toContain("জানু");
    // Latin digits preserved — Bangla numerals are out of scope.
    expect(formatDate("2026-01-15", "bn")).toMatch(/[0-9]/);
    expect(formatDate("2026-01-15", "bn")).not.toMatch(/[০-৯]/);
  });

  it("follows the module-level active locale set by the language layer", () => {
    setActiveFormatLocale("bn");
    expect(formatDate("2026-01-15")).toContain("জানু");
    setActiveFormatLocale("en");
    expect(formatDate("2026-01-15")).toBe("15 Jan 2026");
  });

  it("setAppLanguage flips the date locale along with the UI language", async () => {
    await setAppLanguage("bn");
    expect(formatDate("2026-01-15")).toContain("জানু");
    await setAppLanguage("en");
    expect(formatDate("2026-01-15")).toBe("15 Jan 2026");
  });

  it("money stays deterministic BDT with Latin digits regardless of locale", () => {
    setActiveFormatLocale("bn");
    expect(formatCurrency("1234.5")).toBe("৳1,234.50");
    expect(formatDate("2026-01-15", "bn")).toContain("জানু");
  });
});
