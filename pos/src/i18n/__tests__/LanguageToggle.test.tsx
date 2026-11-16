import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";

import { LanguageToggle } from "../LanguageToggle.js";
import { LANG_STORAGE_KEY } from "../language.js";
import "../index.js";

describe("LanguageToggle", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18next.changeLanguage("en");
  });

  it("renders both language options with EN active by default", () => {
    render(<LanguageToggle />);
    expect(screen.getByRole("button", { name: "EN" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "বাংলা" })).toHaveAttribute("aria-pressed", "false");
  });

  it("switches to Bangla, persists the choice, and switches back", async () => {
    const user = userEvent.setup();
    render(<LanguageToggle />);
    await user.click(screen.getByRole("button", { name: "বাংলা" }));
    expect(i18next.language).toBe("bn");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("bn");
    expect(screen.getByRole("button", { name: "বাংলা" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "EN" }));
    expect(i18next.language).toBe("en");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("en");
    expect(screen.getByRole("button", { name: "EN" })).toHaveAttribute("aria-pressed", "true");
  });

  it("follows language changes made in another tab (storage event)", async () => {
    render(<LanguageToggle />);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: LANG_STORAGE_KEY, newValue: "bn" }),
      );
    });
    await waitFor(() => expect(i18next.language).toBe("bn"));
    expect(screen.getByRole("button", { name: "বাংলা" })).toHaveAttribute("aria-pressed", "true");
  });
});
