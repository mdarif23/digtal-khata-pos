import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatePayments } from "./sales.validation.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";

// Payment validation runs in INTEGER POISHA math — these tests pin the
// float-trap guarantees (the sale's money truth), not just error messages.

describe("validatePayments", () => {
  it("requires at least one payment row", () => {
    assert.throws(() => validatePayments([], 100, null), NotFoundError);
  });

  it("rejects duplicate payment methods", () => {
    assert.throws(
      () =>
        validatePayments(
          [
            { method: "cash", amount: 50 },
            { method: "cash", amount: 50 },
          ],
          100,
          null,
        ),
      ConflictError,
    );
  });

  it("requires a transaction reference for card and QR payments", () => {
    assert.throws(
      () =>
        validatePayments([{ method: "card", amount: 50, reference: "abc" }], 50, null),
      BadRequestError,
    );
    assert.throws(
      () => validatePayments([{ method: "bangla_qr", amount: 50 }], 50, null),
      BadRequestError,
    );
  });

  it("does not demand a reference for zero-amount card rows", () => {
    const result = validatePayments(
      [
        { method: "card", amount: 0 },
        { method: "cash", amount: 100 },
      ],
      100,
      null,
    );
    assert.equal(result.paidAmount, 100);
  });

  it("requires the full code for gift card payments", () => {
    assert.throws(
      () =>
        validatePayments(
          [{ method: "gift_card", amount: 50, reference: "short" }],
          50,
          1,
        ),
      BadRequestError,
    );
  });

  it("requires a customer for due payments", () => {
    assert.throws(
      () => validatePayments([{ method: "due", amount: 50 }], 50, null),
      BadRequestError,
    );
  });

  it("requires a customer for store credit and loyalty payments", () => {
    assert.throws(
      () =>
        validatePayments([{ method: "store_credit", amount: 50 }], 50, null),
      BadRequestError,
    );
    assert.throws(
      () =>
        validatePayments([{ method: "loyalty_points", amount: 50 }], 50, null),
      BadRequestError,
    );
  });

  it("rejects payments that do not settle exactly (over and under)", () => {
    assert.throws(
      () => validatePayments([{ method: "cash", amount: 120 }], 100, null),
      /equal the final total/,
    );
    assert.throws(
      () =>
        validatePayments(
          [
            { method: "cash", amount: 100 },
            { method: "card", amount: 10, reference: "tx-123456" },
          ],
          100,
          null,
        ),
      BadRequestError,
    );
  });

  it("accepts an exact cash sale", () => {
    assert.deepEqual(
      validatePayments([{ method: "cash", amount: 100 }], 100, null),
      { change: 0, dueAmount: 0, paidAmount: 100 },
    );
  });

  it("survives floating-point amounts via poisha integers", () => {
    const result = validatePayments(
      [
        { method: "cash", amount: 0.1 },
        { method: "card", amount: 0.2, reference: "tx-123456" },
      ],
      0.3,
      null,
    );
    assert.equal(result.paidAmount, 0.3);
    assert.equal(result.dueAmount, 0);
  });

  it("splits cash and due for a customer", () => {
    assert.deepEqual(
      validatePayments(
        [
          { method: "cash", amount: 60 },
          { method: "due", amount: 40 },
        ],
        100,
        7,
      ),
      { change: 0, dueAmount: 40, paidAmount: 60 },
    );
  });

  it("returns change for excess tendered and none when not tendered", () => {
    assert.deepEqual(
      validatePayments(
        [{ method: "cash", amount: 50, tendered: 80 }],
        50,
        null,
      ),
      { change: 30, dueAmount: 0, paidAmount: 50 },
    );
    assert.equal(
      validatePayments([{ method: "cash", amount: 50 }], 50, null).change,
      0,
    );
  });

  it("rejects cash tendered below the payment amount", () => {
    assert.throws(
      () =>
        validatePayments(
          [{ method: "cash", amount: 50, tendered: 40 }],
          50,
          null,
        ),
      NotFoundError,
    );
  });

  it("rejects negative amounts", () => {
    assert.throws(
      () => validatePayments([{ method: "cash", amount: -5 }], 100, null),
      BadRequestError,
    );
  });

  it("rejects a non-due method row without an amount", () => {
    assert.throws(
      () =>
        validatePayments(
          [{ method: "cash" }, { method: "due", amount: 100 }],
          100,
          1,
        ),
      /Invalid payment amount/,
    );
  });
});
