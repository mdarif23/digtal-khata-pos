import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildVariantName,
  buildVariantOptionsLabel,
  type VariantOptionInput,
} from "./variantDisplay.js";

describe("buildVariantOptionsLabel", () => {
  it("joins option values with ', '", () => {
    assert.equal(
      buildVariantOptionsLabel([{ name: "Color", value: "Red" }, { name: "Size", value: "Large" }]),
      "Red, Large",
    );
  });

  it("returns '' for null/undefined/empty option lists", () => {
    assert.equal(buildVariantOptionsLabel(null), "");
    assert.equal(buildVariantOptionsLabel(undefined), "");
    assert.equal(buildVariantOptionsLabel([]), "");
  });

  it("filters null, undefined, empty and whitespace-only values", () => {
    assert.equal(
      buildVariantOptionsLabel([
        { name: "A", value: null },
        { name: "B", value: undefined },
        { name: "C", value: "" },
        { name: "D", value: "   " },
        { name: "E", value: "Real" },
      ]),
      "Real",
    );
  });

  it("trims surrounding whitespace from values", () => {
    assert.equal(
      buildVariantOptionsLabel([{ name: "Size", value: "  Small  " }]),
      "Small",
    );
  });

  it("drops duplicate values while preserving first-seen order", () => {
    assert.equal(
      buildVariantOptionsLabel([
        { name: "Color", value: "Red" },
        { name: "Tone", value: "Red" },
        { name: "Size", value: "Large" },
      ]),
      "Red, Large",
    );
  });

  it("preserves the given option ordering", () => {
    assert.equal(
      buildVariantOptionsLabel([{ name: "Size", value: "Large" }, { name: "Color", value: "Red" }]),
      "Large, Red",
    );
  });

  it("treats non-string values as missing", () => {
    assert.equal(
      buildVariantOptionsLabel([{ value: 42 as unknown as string }, { value: "OK" }]),
      "OK",
    );
  });
});

describe("buildVariantName", () => {
  it("returns the bare product name without variants", () => {
    assert.equal(buildVariantName("Water Bottle", []), "Water Bottle");
    assert.equal(buildVariantName("Water Bottle", null), "Water Bottle");
    assert.equal(buildVariantName("Water Bottle", undefined), "Water Bottle");
  });

  it("appends one option value", () => {
    assert.equal(buildVariantName("Football", [{ name: "Size", value: "Small" }]), "Football (Small)");
  });

  it("appends multiple option values", () => {
    assert.equal(
      buildVariantName("T-Shirt", [{ name: "Color", value: "Red" }, { name: "Size", value: "Large" }]),
      "T-Shirt (Red, Large)",
    );
  });

  it("never renders an empty parenthetical", () => {
    assert.equal(buildVariantName("Football", [{ name: "Size", value: "" }]), "Football");
    assert.equal(buildVariantName("Football", [{ name: "Size", value: "   " }]), "Football");
    assert.equal(buildVariantName("Football", [{ name: "Size", value: null }]), "Football");
  });

  it("handles missing/blank product names", () => {
    assert.equal(buildVariantName(null, [{ value: "Small" }]), "(Small)");
    assert.equal(buildVariantName("   ", [{ value: "Small" }]), "(Small)");
    assert.equal(buildVariantName(null, []), "");
    assert.equal(buildVariantName(undefined, []), "");
  });

  it("does not mutate or depend on the caller's option object shape", () => {
    const options: VariantOptionInput[] = [{ name: "Size", value: " Small " }, { name: "Color", value: null }];
    assert.equal(buildVariantName("Football", options), "Football (Small)");
    const first = options[0] as { value?: string | null };
    assert.equal(first.value, " Small ");
  });
});
