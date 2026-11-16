import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";

import { RegisterDialog } from "@/features/cashRegisters/components/RegisterDialog.js";
import { MOVEMENT_LABEL_KEYS, MOVEMENT_LABELS } from "@/features/cashRegisters/registers.api.js";
import "../index.js";

// Register state loads on open — quiet defaults (no session, no registers).
vi.mock("../../api/axios.js", () => ({
  default: {
    get: vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("registers")) return { data: { data: [] } };
      if (url.includes("denomination")) return { data: { data: [] } };
      return { data: { data: null } };
    }),
    post: vi.fn(),
  },
}));

const KEY_SHAPED = /\b(?:pos|common|payment|saleSuccess|register):[A-Za-z0-9_.]+\b/;

function expectNoRawKeys(container: HTMLElement) {
  const text = container.textContent ?? "";
  const hits = text.match(new RegExp(KEY_SHAPED.source, "g")) ?? [];
  expect(hits).toEqual([]);
}

describe("RegisterDialog renders in Bangla (Phase 5)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18next.changeLanguage("bn");
  });

  it("toolbar button, dialog chrome and open-register form render in Bangla", async () => {
    const user = userEvent.setup();
    const { container } = render(<RegisterDialog />);
    await user.click(screen.getByRole("button", { name: "রেজিস্টার" }));
    await waitFor(() =>
      expect(screen.getByText("ক্যাশ ড্রয়ার")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("টাকা নিতে ড্রয়ার খুলুন।"),
    ).toBeInTheDocument();
    expect(screen.getByText("প্রারম্ভিক নগদ")).toBeInTheDocument();
    expect(screen.getByText("ড্রয়ার খুলুন")).toBeInTheDocument();
    expect(
      screen.getByText("এখনো কোনো রেজিস্টার নেই — এই লোকেশনের জন্য ম্যানেজারকে তৈরি করতে বলুন।"),
    ).toBeInTheDocument();
    expectNoRawKeys(container);
  });

  it("movement labels share one key set with MOVEMENT_LABELS (defaults match)", () => {
    expect(MOVEMENT_LABEL_KEYS.cash_in).toBe("register:movement.cash_in");
    expect(i18next.t(MOVEMENT_LABEL_KEYS.cash_in, { defaultValue: MOVEMENT_LABELS.cash_in })).toBe(
      "নগদ যোগ",
    );
    expect(
      i18next.t(MOVEMENT_LABEL_KEYS.safe_deposit, {
        defaultValue: MOVEMENT_LABELS.safe_deposit,
      }),
    ).toBe("সেফে জমা (ড্রপ)");
  });
});
