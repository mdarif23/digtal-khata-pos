import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  productImportRows,
  productImportSessions,
} from "../../db/schema/productImport.js";
import { customers } from "../../db/schema/customers.js";
import { suppliers } from "../../db/schema/suppliers.js";
import {
  assertUploadAcceptable,
  parseCsvUpload,
  parseXlsxUpload,
} from "../productImport/fileParser.service.js";
import { recordAudit } from "../../services/audit.js";
import { guardCsvCell, safeCsvCell } from "../../utils/csv.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/handleError.js";

/**
 * Contact (customers/suppliers) bulk import — Phase 1 (master prompt F11).
 *
 * Reuses the product-import session machinery (0047/0066): sessions carry an
 * entity_type, rows persist per-row validation errors and results, and the
 * one-running-per-business guard is per business+entity. Execution is
 * IDEMPOTENT: rows already created/updated are skipped on re-run, so an
 * interrupted run is resumed safely instead of duplicating contacts.
 *
 * Financial opening balances are deliberately NOT imported (master prompt:
 * only "where supported by existing accounting rules") — dues need the
 * ledger, which is out of scope for this phase.
 */

export type ContactEntity = "customers" | "suppliers";

const MAX_ROWS = Number(process.env.PRODUCT_IMPORT_MAX_ROWS ?? 2000);

const HEADER_ALIASES: Record<string, string> = {
  name: "name",
  "full name": "name",
  "customer name": "name",
  "supplier name": "name",
  phone: "phone",
  mobile: "phone",
  "phone number": "phone",
  contact: "phone",
  "contact number": "phone",
  email: "email",
  "e-mail": "email",
  address: "address",
  status: "status",
};

export const CONTACT_TEMPLATE_COLUMNS: Record<ContactEntity, string[]> = {
  customers: ["name", "phone", "email", "address"],
  suppliers: ["name", "phone", "email", "address", "status"],
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface NormalizedRow {
  rowNumber: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  status: string;
  errors: { code: string; message: string; field?: string }[];
}

export interface ContactTemplate {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export async function generateContactTemplate(
  entity: ContactEntity,
  format: "csv" | "xlsx",
): Promise<ContactTemplate> {
  const columns = CONTACT_TEMPLATE_COLUMNS[entity];
  if (format === "xlsx") {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(entity);
    sheet.addRow(columns);
    const buffer = await workbook.xlsx.writeBuffer();
    return {
      filename: `${entity}-import-template.xlsx`,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: Buffer.from(buffer),
    };
  }
  const csv = `${columns.map(guardCsvCell).join(",")}\r\n`;
  return {
    filename: `${entity}-import-template.csv`,
    contentType: "text/csv; charset=utf-8",
    bytes: Buffer.from(`\uFEFF${csv}`, "utf8"),
  };
}

function normalizeHeader(header: string): string | null {
  const key = header.trim().toLowerCase();
  return HEADER_ALIASES[key] ?? null;
}

async function parseSheet(
  bytes: Buffer,
  mimeType: string | null,
): Promise<{ headers: string[]; rows: Record<string, string | null>[] }> {
  const isXlsx =
    mimeType?.includes("spreadsheetml") === true ||
    mimeType?.includes("ms-excel") === true;
  if (isXlsx) {
    const parsed = await parseXlsxUpload(bytes, null, 1);
    return { headers: parsed.headers, rows: parsed.rows };
  }
  const parsed = parseCsvUpload(bytes, 1);
  return { headers: parsed.headers, rows: parsed.rows };
}

export async function createContactImportSession(input: {
  businessId: number;
  userId: number;
  entity: ContactEntity;
  filename: string;
  mimeType: string | null;
  bytes: Buffer;
  maxFileMb: number;
}): Promise<{
  sessionId: number;
  totalRows: number;
  errorCount: number;
  duplicateOf: number | null;
}> {
  assertUploadAcceptable({
    filename: input.filename,
    mimeType: input.mimeType,
    bytes: input.bytes,
    maxMb: input.maxFileMb,
  });

  const { headers, rows } = await parseSheet(input.bytes, input.mimeType);
  const mapped = headers
    .map((h) => ({ header: h, field: normalizeHeader(h) }))
    .filter((h): h is { header: string; field: string } => h.field !== null);
  if (!mapped.some((m) => m.field === "name")) {
    throw new BadRequestError(
      "The file needs a 'name' column (aliases: full name / customer name / supplier name).",
    );
  }

  // One running session per business+entity (partial unique index 0066).
  const [running] = await db
    .select({ id: productImportSessions.id })
    .from(productImportSessions)
    .where(
      and(
        eq(productImportSessions.businessId, input.businessId),
        eq(productImportSessions.entityType, input.entity),
        eq(productImportSessions.status, "running"),
      ),
    );
  if (running) {
    throw new ConflictError(
      "Another import for this entity is still running. Wait for it to finish or resume it.",
    );
  }

  if (rows.length === 0) {
    throw new BadRequestError("The file contains no data rows.");
  }
  if (rows.length > MAX_ROWS) {
    throw new BadRequestError(
      `The file has ${rows.length} rows — the limit is ${MAX_ROWS}. Split the file.`,
    );
  }

  const fileHash = createHash("sha256").update(input.bytes).digest("hex");
  // Duplicate-file detection (same as product imports): informational.
  const [dupe] = await db
    .select({ id: productImportSessions.id })
    .from(productImportSessions)
    .where(
      and(
        eq(productImportSessions.businessId, input.businessId),
        eq(productImportSessions.entityType, input.entity),
        eq(productImportSessions.fileHash, fileHash),
        eq(productImportSessions.status, "completed"),
      ),
    );

  const normalized: NormalizedRow[] = rows.map((cells, idx) => {
    const rowNumber = idx + 2; // header-aware, 1-based
    const get = (field: string): string | null => {
      const col = mapped.find((m) => m.field === field);
      if (!col) return null;
      const value = (cells[col.header] ?? "").trim();
      return value === "" ? null : value;
    };
    const name = get("name") ?? "";
    const phone = get("phone");
    const email = get("email");
    const errors: NormalizedRow["errors"] = [];
    if (name.length > 255) {
      errors.push({ code: "name_too_long", message: "Name exceeds 255 characters.", field: "name" });
    }
    if (phone && phone.length > 20) {
      errors.push({ code: "phone_too_long", message: "Phone exceeds 20 characters.", field: "phone" });
    }
    if (email && !EMAIL_PATTERN.test(email)) {
      errors.push({ code: "email_invalid", message: "Email format is invalid.", field: "email" });
    }
    let status = "active";
    if (input.entity === "suppliers") {
      const rawStatus = (get("status") ?? "active").toLowerCase();
      if (!["active", "inactive"].includes(rawStatus)) {
        errors.push({
          code: "status_invalid",
          message: "Status must be active or inactive.",
          field: "status",
        });
      }
      status = rawStatus === "inactive" ? "inactive" : "active";
    }
    return {
      rowNumber,
      name,
      phone,
      email,
      address: get("address"),
      status,
      errors,
    };
  });

  // In-file duplicate match keys: same phone (or same name when neither
  // phone nor email) would otherwise silently collapse.
  const seenPhone = new Set<string>();
  const seenNameless = new Set<string>();
  for (const row of normalized) {
    if (row.phone) {
      const key = row.phone.toLowerCase();
      if (seenPhone.has(key)) {
        row.errors.push({
          code: "duplicate_in_file",
          message: `Phone ${row.phone} appears more than once in the file.`,
          field: "phone",
        });
      }
      seenPhone.add(key);
    } else if (!row.email && row.name) {
      const key = row.name.toLowerCase();
      if (seenNameless.has(key)) {
        row.errors.push({
          code: "duplicate_in_file",
          message: `Name "${row.name}" appears more than once without a phone or email to tell them apart.`,
          field: "name",
        });
      }
      seenNameless.add(key);
    }
  }

  const [session] = await db
    .insert(productImportSessions)
    .values({
      businessId: input.businessId,
      createdBy: input.userId,
      entityType: input.entity,
      filename: input.filename.slice(0, 255),
      fileHash,
      fileSize: input.bytes.length,
      status: "validated",
      totals: {
        total: normalized.length,
        valid: normalized.filter((r) => r.errors.length === 0).length,
        errors: normalized.filter((r) => r.errors.length > 0).length,
      },
    })
    .returning({ id: productImportSessions.id });
  if (!session) {
    throw new Error("Import session insert returned no row.");
  }

  await db.insert(productImportRows).values(
    normalized.map((row) => ({
      businessId: input.businessId,
      sessionId: session.id,
      rowNumber: row.rowNumber,
      productRef: row.name.slice(0, 255),
      status: row.errors.length > 0 ? ("error" as const) : ("valid" as const),
      payload: {
        name: row.name,
        phone: row.phone,
        email: row.email,
        address: row.address,
        status: row.status,
      },
      errors: row.errors.length > 0 ? row.errors : null,
    })),
  );

  recordAudit({
    businessId: input.businessId,
    actorUserId: input.userId,
    action: `${input.entity}.import_uploaded`,
    entityType: "import_session",
    entityId: session.id,
    metadata: {
      entity: input.entity,
      rows: normalized.length,
      duplicateOf: dupe?.id ?? null,
    },
  });

  return {
    sessionId: session.id,
    totalRows: normalized.length,
    errorCount: normalized.filter((r) => r.errors.length > 0).length,
    duplicateOf: dupe?.id ?? null,
  };
}

export async function getContactSessionDetail(
  businessId: number,
  sessionId: number,
) {
  const [session] = await db
    .select()
    .from(productImportSessions)
    .where(
      and(
        eq(productImportSessions.id, sessionId),
        eq(productImportSessions.businessId, businessId),
      ),
    )
    .limit(1);
  if (!session) {
    throw new NotFoundError("Import session not found.");
  }
  const rows = await db
    .select({
      id: productImportRows.id,
      rowNumber: productImportRows.rowNumber,
      productRef: productImportRows.productRef,
      status: productImportRows.status,
      errors: productImportRows.errors,
      result: productImportRows.result,
    })
    .from(productImportRows)
    .where(
      and(
        eq(productImportRows.sessionId, sessionId),
        eq(productImportRows.businessId, businessId),
      ),
    )
    .orderBy(productImportRows.rowNumber);
  return { session, rows };
}

/** Downloadable row-level error report (guarded CSV). */
export async function buildContactErrorReport(
  businessId: number,
  sessionId: number,
): Promise<{ filename: string; contentType: string; bytes: Buffer }> {
  const { session, rows } = await getContactSessionDetail(businessId, sessionId);
  const lines = [
    ["row", "name", "status", "errors"].map(guardCsvCell).join(","),
    ...rows
      .filter((r) => r.status === "error" || r.status === "failed")
      .map((r) =>
        [
          r.rowNumber,
          r.productRef ?? "",
          r.status,
          (r.errors as { code: string; message: string }[] | null)
            ?.map((e) => `${e.code}: ${e.message}`)
            .join(" | ") ?? "",
        ]
          .map(safeCsvCell)
          .join(","),
      ),
  ];
  return {
    filename: `${session.entityType}-import-errors-${sessionId}.csv`,
    contentType: "text/csv; charset=utf-8",
    bytes: Buffer.from(`\uFEFF${lines.join("\r\n")}`, "utf8"),
  };
}

/**
 * Executes the pending/valid rows of a contact import session — IDEMPOTENT
 * (created/updated rows are skipped on re-run). Runs synchronously when
 * awaited; the route kicks it in the background via setImmediate and the
 * wizard polls GET /api/import/sessions/:id for progress.
 */
export async function executeContactImport(input: {
  businessId: number;
  userId: number;
  sessionId: number;
}): Promise<{ processed: number; created: number; updated: number; failed: number }> {
  const [session] = await db
    .select()
    .from(productImportSessions)
    .where(
      and(
        eq(productImportSessions.id, input.sessionId),
        eq(productImportSessions.businessId, input.businessId),
      ),
    )
    .for("update");
  if (!session) {
    throw new NotFoundError("Import session not found.");
  }
  if (session.entityType !== "customers" && session.entityType !== "suppliers") {
    throw new BadRequestError("This session is not a contact import.");
  }
  const entity = session.entityType as ContactEntity;
  if (session.status === "completed") {
    return { processed: 0, created: 0, updated: 0, failed: 0 };
  }
  if (session.status !== "validated" && session.status !== "running") {
    throw new BadRequestError(
      `Session is ${session.status} — only validated sessions can execute.`,
    );
  }
  await db
    .update(productImportSessions)
    .set({ status: "running" })
    .where(eq(productImportSessions.id, input.sessionId));

  // Only rows not yet applied — the resume path lands here too.
  const pendingRows = await db
    .select()
    .from(productImportRows)
    .where(
      and(
        eq(productImportRows.sessionId, input.sessionId),
        inArray(productImportRows.status, ["pending", "valid"]),
      ),
    )
    .orderBy(productImportRows.rowNumber);

  // Preload ALL existing match keys for the business (contacts are small).
  const table = entity === "customers" ? customers : suppliers;
  const existing = await db
    .select({ id: table.id, name: table.name, phone: table.phone, email: table.email })
    .from(table)
    .where(eq(table.businessId, input.businessId));
  const idByPhone = new Map<string, number>();
  const idByEmail = new Map<string, number>();
  for (const row of existing) {
    if (row.phone) idByPhone.set(row.phone.toLowerCase(), row.id);
    if (row.email) idByEmail.set(row.email.toLowerCase(), row.id);
  }

  let created = 0;
  let updated = 0;
  let failed = 0;
  for (const row of pendingRows) {
    const payload = row.payload as
      | { name?: string; phone?: string | null; email?: string | null; address?: string | null; status?: string }
      | null;
    if (!payload?.name) {
      await db
        .update(productImportRows)
        .set({
          status: "failed",
          result: { error: "Row payload missing a name." },
        })
        .where(eq(productImportRows.id, row.id));
      failed += 1;
      continue;
    }
    try {
      const matchId =
        (payload.phone ? idByPhone.get(payload.phone.toLowerCase()) : undefined) ??
        (payload.email ? idByEmail.get(payload.email.toLowerCase()) : undefined);
      if (matchId) {
        await db
          .update(table)
          .set({
            name: payload.name,
            phone: payload.phone ?? null,
            email: payload.email ?? null,
            address: payload.address ?? null,
            ...(entity === "suppliers" && payload.status
              ? { status: payload.status }
              : {}),
          })
          .where(and(eq(table.id, matchId), eq(table.businessId, input.businessId)));
        await db
          .update(productImportRows)
          .set({ status: "updated", result: { id: matchId, action: "updated" } })
          .where(eq(productImportRows.id, row.id));
        updated += 1;
      } else {
        const [inserted] = await db
          .insert(table)
          .values({
            businessId: input.businessId,
            name: payload.name,
            phone: payload.phone ?? null,
            email: payload.email ?? null,
            address: payload.address ?? null,
            ...(entity === "suppliers" ? { status: payload.status ?? "active" } : {}),
          })
          .returning({ id: table.id });
        if (!inserted) throw new Error("Insert returned no row.");
        if (payload.phone) idByPhone.set(payload.phone.toLowerCase(), inserted.id);
        if (payload.email) idByEmail.set(payload.email.toLowerCase(), inserted.id);
        await db
          .update(productImportRows)
          .set({ status: "created", result: { id: inserted.id, action: "created" } })
          .where(eq(productImportRows.id, row.id));
        created += 1;
      }
    } catch (err) {
      failed += 1;
      await db
        .update(productImportRows)
        .set({
          status: "failed",
          result: {
            error: err instanceof Error ? err.message.slice(0, 300) : "Row failed.",
          },
        })
        .where(eq(productImportRows.id, row.id));
    }
  }

  await db
    .update(productImportSessions)
    .set({
      status: "completed",
      totals: {
        total: pendingRows.length,
        created,
        updated,
        failed,
      },
    })
    .where(
      and(
        eq(productImportSessions.id, input.sessionId),
        eq(productImportSessions.businessId, input.businessId),
      ),
    );
  recordAudit({
    businessId: input.businessId,
    actorUserId: input.userId,
    action: `${entity}.import_completed`,
    entityType: "import_session",
    entityId: input.sessionId,
    metadata: { rows: pendingRows.length, created, updated, failed },
  });
  return { processed: pendingRows.length, created, updated, failed };
}

/** Session history for the contact imports (recent first). */
export async function listContactImportHistory(
  businessId: number,
  entities: ContactEntity[],
) {
  return db
    .select({
      id: productImportSessions.id,
      entity: productImportSessions.entityType,
      filename: productImportSessions.filename,
      status: productImportSessions.status,
      totals: productImportSessions.totals,
      createdAt: productImportSessions.createdAt,
    })
    .from(productImportSessions)
    .where(
      and(
        eq(productImportSessions.businessId, businessId),
        inArray(productImportSessions.entityType, entities),
      ),
    )
    .orderBy(sql`${productImportSessions.id} DESC`)
    .limit(25);
}
