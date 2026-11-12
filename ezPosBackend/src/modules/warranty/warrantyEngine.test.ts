import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addWarrantyDuration,
  isWarrantyClaimable,
} from "./warrantyEngine.service.js";

/** UTC midnight helper so assertions never drift with the host timezone. */
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe("addWarrantyDuration", () => {
  it("adds days", () => {
    assert.equal(
      addWarrantyDuration(utc(2026, 1, 31), 30, "days").toISOString(),
      utc(2026, 3, 2).toISOString(),
    );
  });

  it("adds years across leap boundaries", () => {
    assert.equal(
      addWarrantyDuration(utc(2028, 2, 29), 1, "years").toISOString(),
      utc(2029, 2, 28).toISOString(),
    );
    assert.equal(
      addWarrantyDuration(utc(2027, 3, 1), 1, "years").toISOString(),
      utc(2028, 3, 1).toISOString(),
    );
  });

  it("clamps month-end dates to the target month's last day", () => {
    // Jan 31 + 1 month = Feb 28 (2026 is not a leap year)
    assert.equal(
      addWarrantyDuration(utc(2026, 1, 31), 1, "months").toISOString(),
      utc(2026, 2, 28).toISOString(),
    );
    // Jan 31 + 1 month = Feb 29 in a leap year
    assert.equal(
      addWarrantyDuration(utc(2028, 1, 31), 1, "months").toISOString(),
      utc(2028, 2, 29).toISOString(),
    );
    // Aug 31 + 1 month = Sep 30
    assert.equal(
      addWarrantyDuration(utc(2026, 8, 31), 1, "months").toISOString(),
      utc(2026, 9, 30).toISOString(),
    );
    // Mar 31 + 11 months = Feb 28 next year (never Mar 3 from overflow)
    assert.equal(
      addWarrantyDuration(utc(2026, 3, 31), 11, "months").toISOString(),
      utc(2027, 2, 28).toISOString(),
    );
    // Dec 31 + 2 months crosses the year boundary
    assert.equal(
      addWarrantyDuration(utc(2027, 12, 31), 2, "months").toISOString(),
      utc(2028, 2, 29).toISOString(),
    );
  });

  it("keeps normal month arithmetic exact", () => {
    assert.equal(
      addWarrantyDuration(utc(2026, 5, 15), 12, "months").toISOString(),
      utc(2027, 5, 15).toISOString(),
    );
  });

  it("adds zero-duration days unchanged (guarded upstream, safe here)", () => {
    assert.equal(
      addWarrantyDuration(utc(2026, 11, 12), 1, "days").toISOString(),
      utc(2026, 11, 13).toISOString(),
    );
  });
});

describe("isWarrantyClaimable", () => {
  const now = utc(2026, 11, 12);

  it("allows an active unexpired warranty", () => {
    assert.deepEqual(
      isWarrantyClaimable(
        {
          status: "active",
          expiryDate: utc(2027, 11, 12),
          quantity: 1,
          returnedQuantity: 0,
        },
        now,
      ),
      { ok: true },
    );
  });

  it("allows a claim on the expiry date itself (inclusive expiry)", () => {
    assert.deepEqual(
      isWarrantyClaimable(
        {
          status: "active",
          expiryDate: now,
          quantity: 3,
          returnedQuantity: 1,
        },
        now,
      ),
      { ok: true },
    );
  });

  it("rejects expired warranties", () => {
    const check = isWarrantyClaimable(
      {
        status: "active",
        expiryDate: new Date(now.getTime() - 1),
        quantity: 1,
        returnedQuantity: 0,
      },
      now,
    );
    assert.equal(check.ok, false);
    assert.match(check.reason ?? "", /expired/i);
  });

  it("rejects voided warranties", () => {
    const check = isWarrantyClaimable(
      {
        status: "voided",
        expiryDate: utc(2027, 1, 1),
        quantity: 1,
        returnedQuantity: 0,
      },
      now,
    );
    assert.equal(check.ok, false);
    assert.match(check.reason ?? "", /voided/i);
  });

  it("rejects suspended warranties", () => {
    assert.equal(
      isWarrantyClaimable(
        {
          status: "suspended",
          expiryDate: utc(2027, 1, 1),
          quantity: 1,
          returnedQuantity: 0,
        },
        now,
      ).ok,
      false,
    );
  });

  it("rejects replaced warranties", () => {
    const check = isWarrantyClaimable(
      {
        status: "replaced",
        expiryDate: utc(2027, 1, 1),
        quantity: 1,
        returnedQuantity: 0,
      },
      now,
    );
    assert.equal(check.ok, false);
    assert.match(check.reason ?? "", /replaced/i);
  });

  it("rejects warranties whose covered units were all returned", () => {
    const check = isWarrantyClaimable(
      {
        status: "active",
        expiryDate: utc(2027, 1, 1),
        quantity: 3,
        returnedQuantity: 3,
      },
      now,
    );
    assert.equal(check.ok, false);
    assert.match(check.reason ?? "", /returned/i);
  });

  it("keeps a partially returned quantity warranty claimable", () => {
    assert.deepEqual(
      isWarrantyClaimable(
        {
          status: "active",
          expiryDate: utc(2027, 1, 1),
          quantity: 3,
          returnedQuantity: 2,
        },
        now,
      ),
      { ok: true },
    );
  });
});
