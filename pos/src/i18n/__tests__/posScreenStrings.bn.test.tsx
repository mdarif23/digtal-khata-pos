import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";

import CartItems from "@/features/pos/components/pos/CartItems.js";
import { PosHotkeyManager } from "@/features/pos/hotkeys/PosHotkeyManager.js";
import "../index.js";

/**
 * Phase 5 acceptance: representative bn renders for the PosPage surface
 * (topbar/hotkey cheatsheet + cart empty state) and no raw key paths
 * anywhere. PosPage's own toast strings are error-path strings asserted at
 * the resource level here; the full sale-flow bn render lives with the
 * PaymentModal/SaleSuccessDialog tests (commit 3).
 */

const KEY_SHAPED = /\b(?:pos|common|payment|saleSuccess|register):[A-Za-z0-9_.]+\b/;

function expectNoRawKeys(container: HTMLElement) {
  const text = container.textContent ?? "";
  const hits = text.match(new RegExp(KEY_SHAPED.source, "g")) ?? [];
  expect(hits).toEqual([]);
}

describe("POS screens render in Bangla (Phase 5)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18next.changeLanguage("bn");
  });

  it("CartItems shows the Bangla empty state", () => {
    const { container } = render(<CartItems />);
    expect(screen.getByText("কার্ট খালি")).toBeInTheDocument();
    expect(
      screen.getByText("বিক্রি শুরু করতে বারকোড স্ক্যান করুন বা প্রোডাক্টে ক্লিক করুন।"),
    ).toBeInTheDocument();
    expectNoRawKeys(container);
  });

  it("PosHotkeyManager toolbar button and cheatsheet render in Bangla", async () => {
    const user = userEvent.setup();
    const { container } = render(<PosHotkeyManager />);
    await user.click(screen.getByRole("button", { name: "কীবোর্ড শর্টকাট" }));
    expect(screen.getByText("কীবোর্ড শর্টকাট")).toBeInTheDocument();
    expect(screen.getByText("প্রোডাক্ট সার্চ ও স্ক্যান")).toBeInTheDocument();
    expect(screen.getByText("প্রোডাক্ট সার্চ")).toBeInTheDocument();
    expect(screen.getByText("ছাড় ও পেমেন্ট")).toBeInTheDocument();
    expectNoRawKeys(container);
  });

  it("resolves the PosPage toast strings in Bangla (resource level)", () => {
    expect(i18next.t("pos:cartInvalid")).toBe(
      "কার্টের তথ্য অবৈধ। অনুগ্রহ করে রিফ্রেশ করে আবার চেষ্টা করুন।",
    );
    expect(i18next.t("pos:offlineRecorded")).toBe(
      "নেটওয়ার্ক নেই — বিক্রিটি অফলাইনে রেকর্ড হয়েছে; সংযোগ ফিরলে নিজে থেকেই সিঙ্ক হবে (একই বিক্রি দুবার গণনা হয় না)।",
    );
    expect(i18next.t("pos:drawerDidNotOpen")).toBe("ড্রয়ার খোলেনি");
    expect(i18next.t("pos:saleFailed")).toBe("বিক্রিটি সম্পন্ন করা যায়নি।");
  });

  it("keeps data-derived content and Latin digits intact", () => {
    expect(
      i18next.t("pos:batchLabel", { batch: "FEFO" }),
    ).toBe("ব্যাচ: FEFO");
    expect(i18next.t("pos:maxCharges")).toBe(
      "এক বিক্রিতে সর্বোচ্চ 20টি চার্জ যোগ করা যায়।",
    );
    expect(
      i18next.t("pos:serialAdded", { name: "Coca-Cola 250ml" }),
    ).toBe("Coca-Cola 250ml কার্টে যোগ হয়েছে!");
  });
});
