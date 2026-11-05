import { describe, expect, it } from "vitest";
import {
  createWedgeDetector,
  isEditableTarget,
} from "../wedgeDetector.js";

/** Realistic USB wedge: ~6ms between characters, Enter suffix. */
function scanBurst(
  wedge: ReturnType<typeof createWedgeDetector>,
  code: string,
  startAt = 1_000,
) {
  let at = startAt;
  for (const char of code) {
    wedge.feed(char, at);
    at += 6;
  }
  return wedge.feed("Enter", at);
}

describe("createWedgeDetector", () => {
  it("detects a fast character burst ending with Enter as a scan", () => {
    const wedge = createWedgeDetector();
    const decision = scanBurst(wedge, "4006381333931");
    expect(decision).toEqual({ action: "scan", code: "4006381333931" });
  });

  it("is reusable — a second burst scans again", () => {
    const wedge = createWedgeDetector();
    expect(scanBurst(wedge, "4006381333931", 1_000)).toMatchObject({ action: "scan" });
    expect(scanBurst(wedge, "4006381333932", 2_000)).toMatchObject({ action: "scan" });
  });

  it("treats slow human typing as typing, never a scan", () => {
    const wedge = createWedgeDetector();
    let at = 1_000;
    for (const char of "4006381333931") {
      wedge.feed(char, at);
      at += 120; // human inter-key delay
    }
    expect(wedge.feed("Enter", at)).toEqual({ action: "typing" });
  });

  it("requires a minimum burst length (Enter on a short burst is typing)", () => {
    const wedge = createWedgeDetector();
    wedge.feed("4", 1_000);
    wedge.feed("0", 1_006);
    wedge.feed("0", 1_012);
    expect(wedge.feed("Enter", 1_018)).toEqual({ action: "typing" });
  });

  it("resets the burst when a modifier or navigation key arrives", () => {
    const wedge = createWedgeDetector();
    wedge.feed("4", 1_000);
    wedge.feed("0", 1_006);
    wedge.feed("Shift", 1_012); // modifier resets whatever was building
    wedge.feed("0", 1_018);
    wedge.feed("6", 1_024);
    expect(wedge.feed("Enter", 1_030)).toEqual({ action: "typing" });
  });

  it("starts a new burst after a long gap (repeated deliberate scans)", () => {
    const wedge = createWedgeDetector();
    expect(scanBurst(wedge, "4006381333931", 1_000)).toMatchObject({ action: "scan" });
    // 2s later — a fresh scan of the same code must scan again.
    expect(scanBurst(wedge, "4006381333931", 3_000)).toMatchObject({ action: "scan" });
  });

  it("supports slower scanners via configurable maxCharDelayMs", () => {
    const wedge = createWedgeDetector({ maxCharDelayMs: 200, minBarcodeLength: 4 });
    let at = 1_000;
    for (const char of "SLOWBT123") {
      wedge.feed(char, at);
      at += 150; // slow Bluetooth scanner
    }
    expect(wedge.feed("Enter", at)).toEqual({ action: "scan", code: "SLOWBT123" });
  });
});

describe("isEditableTarget", () => {
  it("protects typing contexts from wedge capture", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(select)).toBe(true);
    expect(isEditableTarget(editable)).toBe(true);
  });

  it("lets page-level capture run over non-editable targets", () => {
    const div = document.createElement("div");
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
  });
});
