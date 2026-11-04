import { describe, expect, it } from "vitest";
import {
  buildVariantName,
  buildVariantOptionsLabel,
  type VariantOptionInput,
} from "./variantDisplay";

describe("buildVariantOptionsLabel", () => {
  it("joins option values with ', '", () => {
    expect(
      buildVariantOptionsLabel([
        { typeName: "Color", value: "Red" },
        { typeName: "Size", value: "Large" },
      ]),
    ).toBe("Red, Large");
  });

  it("returns '' for null/undefined/empty option lists", () => {
    expect(buildVariantOptionsLabel(null)).toBe("");
    expect(buildVariantOptionsLabel(undefined)).toBe("");
    expect(buildVariantOptionsLabel([])).toBe("");
  });

  it("filters null, undefined, empty and whitespace-only values", () => {
    expect(
      buildVariantOptionsLabel([
        { typeName: "A", value: null },
        { typeName: "B", value: undefined },
        { typeName: "C", value: "" },
        { typeName: "D", value: "   " },
        { typeName: "E", value: "Real" },
      ]),
    ).toBe("Real");
  });

  it("drops duplicate values while preserving first-seen order", () => {
    expect(
      buildVariantOptionsLabel([
        { typeName: "Color", value: "Red" },
        { typeName: "Tone", value: "Red" },
        { typeName: "Size", value: "Large" },
      ]),
    ).toBe("Red, Large");
  });

  it("accepts raw value strings (backend variantOptions shape)", () => {
    expect(buildVariantOptionsLabel(["Red, Large"])).toBe("Red, Large");
  });
});

describe("buildVariantName", () => {
  it("returns the bare product name without variants", () => {
    expect(buildVariantName("Water Bottle", [])).toBe("Water Bottle");
    expect(buildVariantName("Water Bottle", null)).toBe("Water Bottle");
    expect(buildVariantName("Water Bottle", undefined)).toBe("Water Bottle");
  });

  it("appends one option value", () => {
    expect(
      buildVariantName("Football", [{ typeName: "Size", value: "Small" }]),
    ).toBe("Football (Small)");
  });

  it("appends multiple option values", () => {
    expect(
      buildVariantName("T-Shirt", [
        { typeName: "Color", value: "Red" },
        { typeName: "Size", value: "Large" },
      ]),
    ).toBe("T-Shirt (Red, Large)");
  });

  it("never renders an empty parenthetical", () => {
    expect(buildVariantName("Football", [{ value: "" }])).toBe("Football");
    expect(buildVariantName("Football", [{ value: "   " }])).toBe("Football");
    expect(buildVariantName("Football", [{ value: null }])).toBe("Football");
  });

  it("passes through an already-joined backend label", () => {
    expect(buildVariantName("Football", ["Small"])).toBe("Football (Small)");
  });

  it("handles missing/blank product names", () => {
    expect(buildVariantName(null, [{ value: "Small" }])).toBe("(Small)");
    expect(buildVariantName("   ", [{ value: "Small" }])).toBe("(Small)");
    expect(buildVariantName(null, [])).toBe("");
  });

  it("does not mutate the caller's option objects", () => {
    const options: VariantOptionInput[] = [
      { typeName: "Size", value: " Small " },
      { typeName: "Color", value: null },
    ];
    expect(buildVariantName("Football", options)).toBe("Football (Small)");
    expect((options[0] as { value: string }).value).toBe(" Small ");
  });
});
