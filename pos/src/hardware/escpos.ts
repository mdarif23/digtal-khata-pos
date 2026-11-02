import type { ReceiptPrintPayload } from "./types.js";

/**
 * ESC/POS command encoder for thermal receipt printers. These are the
 * standard ESC/POS byte sequences implemented by virtually every thermal
 * printer (ESC @ init, ESC a n alignment, ESC ! n emphasis, GS V cut).
 * Output is a Uint8Array ready for a USB bulk transfer.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

class EscPosBuilder {
  private bytes: number[] = [];

  init(): this {
    // ESC @ — initialize printer
    this.bytes.push(ESC, 0x40);
    return this;
  }

  align(mode: "left" | "center" | "right"): this {
    // ESC a n
    const n = mode === "center" ? 1 : mode === "right" ? 2 : 0;
    this.bytes.push(ESC, 0x61, n);
    return this;
  }

  bold(on: boolean): this {
    // ESC ! n — bit 3 (0x08) is emphasized
    this.bytes.push(ESC, 0x21, on ? 0x08 : 0x00);
    return this;
  }

  doubleSize(on: boolean): this {
    // GS ! n — bit 4 height + bit 5 width
    this.bytes.push(GS, 0x21, on ? 0x11 : 0x00);
    return this;
  }

  text(value: string): this {
    // ASCII/latin-1 range only — non-ASCII characters degrade to '?'
    // (Bengali receipt text stays on the browser-print fallback, which
    // renders full Unicode; the USB path is for quick English tickets).
    for (const char of value) {
      const code = char.charCodeAt(0);
      this.bytes.push(code > 0xff ? 0x3f : code);
    }
    this.bytes.push(LF);
    return this;
  }

  feed(lines = 1): this {
    for (let i = 0; i < lines; i += 1) this.bytes.push(LF);
    return this;
  }

  cut(): this {
    // GS V 66 0 — partial cut with feed
    this.bytes.push(GS, 0x56, 0x42, 0x00);
    return this;
  }

  openDrawer(): this {
    // ESC p m t1 t2 — drawer kick pin 2, 50ms pulse
    this.bytes.push(ESC, 0x70, 0x00, 0x19, 0xfa);
    return this;
  }

  build(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** Renders the receipt as an ESC/POS byte stream. */
export function buildReceiptEscPos(payload: ReceiptPrintPayload): Uint8Array {
  const b = new EscPosBuilder();
  const money = (n: number) => n.toFixed(2);

  b.init().align("center").doubleSize(true).bold(true);
  b.text(payload.shopName);
  b.doubleSize(false).bold(false);
  if (payload.cashier) b.text(`Cashier: ${payload.cashier}`);
  b.text(new Date().toLocaleString());
  b.align("left");
  b.text("-".repeat(42));

  for (const line of payload.lines) {
    b.text(`${line.name.slice(0, 24)}`);
    b.text(
      `  ${line.quantity} x ${money(line.unitPrice)}${line.lineTotal !== line.quantity * line.unitPrice ? ` = ${money(line.lineTotal)}` : ""}`,
    );
  }

  b.text("-".repeat(42));
  b.text(`Subtotal: ${money(payload.subtotal)}`);
  if (payload.discount > 0) b.text(`Discount: -${money(payload.discount)}`);
  if (payload.vat > 0) b.text(`VAT: ${money(payload.vat)}`);
  b.bold(true);
  b.text(`TOTAL: ${money(payload.finalTotal)}`);
  b.bold(false);
  b.feed(2);
  if (payload.footer) {
    b.align("center").text(payload.footer);
  }
  b.feed(3).cut();
  return b.build();
}

/** Drawer-kick byte stream (ESC p — pin 2, ~50ms). */
export function buildDrawerKick(): Uint8Array {
  const b = new EscPosBuilder();
  b.openDrawer();
  return b.build();
}
