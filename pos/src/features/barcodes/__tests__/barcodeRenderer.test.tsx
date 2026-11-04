import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderBarcodeSvg, renderBarcodeSvgAny, renderQrSvg } from "../barcodeRenderer.js";

// jsdom has no canvas backend; jsbarcode only uses it for text width
// measurement. A stub keeps the SVG output deterministic in tests.
beforeAll(() => {
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string, ...rest: unknown[]) => {
    const element = original(tag as string, ...(rest as []));
    if (tag === "canvas") {
      (element as HTMLCanvasElement).getContext = (() => ({
        font: "",
        measureText: (text: string) => ({ width: text.length * 7 }),
      })) as unknown as HTMLCanvasElement["getContext"];
    }
    return element;
  });
});

describe("barcode SVG renderer", () => {
  it("renders a valid EAN-13 as an SVG element", () => {
    const svg = renderBarcodeSvg("4006381333931", "ean13", { width: 2, height: 60, margin: 10 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    // Bars must exist as rects.
    expect(svg).toContain("rect");
  });

  it("throws for codes that cannot be encoded (never prints unscannable symbols)", () => {
    expect(() => renderBarcodeSvg("4006381333932", "ean13")).toThrow(/cannot be encoded/);
    expect(() => renderBarcodeSvg("abc", "upca")).toThrow();
  });

  it("renders CODE128 for free-form codes", () => {
    const svg = renderBarcodeSvg("EZ000000000001", "code128");
    expect(svg).toContain("rect");
  });

  it("QR codes render asynchronously as SVG", async () => {
    const svg = await renderQrSvg("4006381333931", 120);
    expect(svg).toContain("<svg");
  });

  it("dispatches QR vs linear in the any-format helper", async () => {
    const qr = await renderBarcodeSvgAny("hello", "qr");
    expect(qr).toContain("<svg");
    const linear = await renderBarcodeSvgAny("036000291452", "upca");
    expect(linear).toContain("rect");
  });
});
