import { describe, expect, it } from "vitest";
import {
  createSection,
  looksLikePageSlug,
  looksLikeSubdomain,
  moveSection,
  removeSection,
  SECTION_TYPE_LABELS,
  toggleSection,
  updateSectionProps,
} from "./online-store-helpers";

const config = {
  tokens: { primaryColor: "#000000" },
  sections: [
    { id: "a", type: "hero", enabled: true, props: { heading: "A" } },
    { id: "b", type: "newsletter", enabled: true, props: {} },
  ],
};

describe("online store helpers", () => {
  it("labels every addable section type", () => {
    for (const type of Object.keys(SECTION_TYPE_LABELS)) {
      expect(typeof SECTION_TYPE_LABELS[type]).toBe("string");
    }
  });

  it("creates schema-safe default sections", () => {
    for (const type of [
      "hero",
      "announcement",
      "featured-categories",
      "featured-products",
      "best-sellers",
      "new-arrivals",
      "promo-banners",
      "brands",
      "testimonials",
      "newsletter",
    ] as const) {
      const section = createSection(type);
      expect(section.type).toBe(type);
      expect(section.enabled).toBe(true);
      expect(section.id.length).toBeGreaterThan(3);
      expect(typeof section.props).toBe("object");
    }
  });

  it("moves sections within bounds only", () => {
    expect(moveSection(config, "a", -1).sections.map((s) => s.id)).toEqual(["a", "b"]);
    expect(moveSection(config, "a", 1).sections.map((s) => s.id)).toEqual(["b", "a"]);
    expect(moveSection(config, "missing", 1).sections.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("toggles, edits props and removes sections immutably", () => {
    const toggled = toggleSection(config, "a");
    expect(toggled.sections[0]?.enabled).toBe(false);
    expect(config.sections[0]?.enabled).toBe(true); // original untouched

    const edited = updateSectionProps(config, "a", { heading: "B" });
    expect(edited.sections[0]?.props.heading).toBe("B");

    const removed = removeSection(config, "a");
    expect(removed.sections.map((s) => s.id)).toEqual(["b"]);
  });

  it("validates subdomains and page slugs client-side", () => {
    expect(looksLikeSubdomain("abc-fashion")).toBe(true);
    expect(looksLikeSubdomain("ab")).toBe(false);
    expect(looksLikeSubdomain("-lead")).toBe(false);
    expect(looksLikeSubdomain("Under_score")).toBe(false);
    expect(looksLikePageSlug("about-us")).toBe(true);
    expect(looksLikePageSlug("About Us")).toBe(false);
    expect(looksLikePageSlug("a--b")).toBe(false);
  });
});
