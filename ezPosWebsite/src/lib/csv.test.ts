import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("joins headers and rows with CRLF", () => {
    expect(toCsv(["a", "b"], [["1", "2"], ["3", "4"]])).toBe(
      "a,b\r\n1,2\r\n3,4",
    );
  });

  it("quotes cells containing commas, quotes, or newlines", () => {
    expect(toCsv(["v"], [["has,comma"], ['has"quote'], ["has\nnewline"]])).toBe(
      'v\r\n"has,comma"\r\n"has""quote"\r\n"has\nnewline"',
    );
  });

  it("renders null and undefined as empty cells", () => {
    expect(toCsv(["a", "b", "c"], [[null, undefined, "x"]])).toBe(
      "a,b,c\r\n,,x",
    );
  });

  it("passes numbers through without quoting", () => {
    expect(toCsv(["n"], [[12.5]])).toBe("n\r\n12.5");
  });
});
