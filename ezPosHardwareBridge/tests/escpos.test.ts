import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDrawerKick, buildDrawerStatusQuery, drawerPinToOperand } from "../src/protocols/escpos/commands.js";

describe("ESC/POS command builders", () => {
  it("builds the exact drawer-kick bytes ESC p m t1 t2", () => {
    // Classic example: pin 2, 50 ms on, 500 ms off → 1B 70 00 19 FA
    assert.deepEqual(
      Array.from(buildDrawerKick({ pin: 2, onMs: 50, offMs: 500 })),
      [0x1b, 0x70, 0x00, 0x19, 0xfa],
    );
    // Pin 5 → m = 1 (49)
    assert.deepEqual(
      Array.from(buildDrawerKick({ pin: 5, onMs: 50, offMs: 500 })),
      [0x1b, 0x70, 0x01, 0x19, 0xfa],
    );
  });

  it("defaults to 50 ms on / 500 ms off", () => {
    assert.deepEqual(
      Array.from(buildDrawerKick({ pin: 2 })),
      [0x1b, 0x70, 0x00, 0x19, 0xfa],
    );
  });

  it("clamps pulse times into the 2–510 ms window", () => {
    // 2000 ms on → clamped to 510 ms = 255 units
    const bytes = buildDrawerKick({ pin: 2, onMs: 2000, offMs: 0 });
    assert.equal(bytes[3], 255);
    assert.equal(bytes[4], 1); // 0 ms → minimum one unit
  });

  it("maps hardware pins to ESC p operands", () => {
    assert.equal(drawerPinToOperand(2), 0);
    assert.equal(drawerPinToOperand(5), 1);
  });

  it("status query is DLE EOT 2", () => {
    assert.deepEqual(Array.from(buildDrawerStatusQuery()), [0x10, 0x04, 0x02]);
  });
});
