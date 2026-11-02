import { describe, expect, it } from "vitest";
import { tokensToStyle, getSkin } from "../src/lib/theme";

describe("theme token conversion", () => {
  it("maps known tokens to CSS variables", () => {
    const style = tokensToStyle({
      primaryColor: "#123456",
      fontHeading: "playfair",
      radius: "lg",
      containerWidth: "wide",
    }) as Record<string, string>;
    expect(style["--sf-primary"]).toBe("#123456");
    expect(style["--sf-font-heading"]).toContain("Playfair");
    expect(style["--sf-radius"]).toBe("1rem");
    expect(style["--sf-container"]).toBe("84rem");
  });

  it("falls back to defaults for missing/unknown values", () => {
    const style = tokensToStyle({}) as Record<string, string>;
    expect(style["--sf-primary"]).toBe("#16a34a");
    const unknown = tokensToStyle({ fontBody: "comic-sans" }) as Record<string, string>;
    expect(unknown["--sf-font-body"]).toContain("system-ui");
  });
});

describe("theme skins", () => {
  it("returns launch skins and a generic fallback", () => {
    expect(getSkin("aura-fashion").headingClass).toContain("uppercase");
    expect(getSkin("nonexistent-theme").headingClass.length).toBeGreaterThan(0);
  });
});
