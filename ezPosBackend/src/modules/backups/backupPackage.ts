import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { PassThrough } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";
import { asc, eq, getTableColumns, sql } from "drizzle-orm";
import { createRequire } from "node:module";
import { db } from "../../db/schema/index.js";
import { businesses } from "../../db/schema/businesses.js";
import { env } from "../../config/env.js";
import {
  ATTACHMENT_TABLES,
  MODULE_GROUPS,
  PROFILE_EXCLUDE,
  TABLE_SPECS,
  type BackupTableSpec,
} from "./backupModules.js";
import {
  BACKUP_FORMAT_VERSION,
  createPackageDecryptor,
  createPackageEncryptor,
  type BackupEnvelopeHeader,
} from "./backupCrypto.js";
import { fetchAttachmentBytes } from "./backupStorage.js";

/**
 * .ezbackup package builder/reader (approved architecture, 2026-11-05).
 *
 * Layout inside the (gzip + AES-256-GCM) tar:
 *   manifest.json        — version, identity, counts, per-file sha256s
 *   metadata.json        — export context (schema key convention, timezone)
 *   data/<table>.json    — row arrays keyed by ORM property names, ordered
 *   attachments/...      — expense-attachment + storefront-media bytes
 *
 * A package is only ever marked completion:"complete" after every module
 * file and attachment entry has been written; readers reject anything else.
 */

let cachedAppVersion: string | null = null;
function resolveAppVersion(): string {
  if (cachedAppVersion) return cachedAppVersion;
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../../../package.json") as { version?: string };
    cachedAppVersion = String(pkg?.version ?? "1.0.0");
  } catch {
    cachedAppVersion = "1.0.0";
  }
  return cachedAppVersion;
}

export interface BackupManifest {
  formatVersion: number;
  application: "ezpos";
  appVersion: string;
  businessId: number;
  businessName: string;
  businessSlug: string;
  businessTimezone: string | null;
  createdAt: string;
  type: string;
  modules: string[];
  recordCounts: Record<string, number>;
  attachmentCounts: Record<string, number>;
  attachments: Array<{
    table: string;
    id: number;
    objectKey: string;
    path: string;
    size: number;
    sha256: string;
  }>;
  warnings: string[];
  checksums: Record<string, string>;
  encryption: { alg: "AES-256-GCM"; keyVersion: number };
  completion: "complete";
}

export interface BuiltPackage {
  filePath: string;
  fileName: string;
  size: number;
  sha256: string;
  manifest: BackupManifest;
  envelope: { header: BackupEnvelopeHeader };
}

type BusinessRow = typeof businesses.$inferSelect;

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;

function scopeSql(spec: BackupTableSpec, businessId: number): SQL_ | undefined {
  const cols = getTableColumns(spec.table as never) as Record<string, never>;
  const bizCol = cols["businessId"];
  if (bizCol) return eq(bizCol as never, businessId) as SQL_;
  // Join tables without business_id scope through their business parents.
  if (spec.name === "product_taxes") {
    return sql`product_id IN (SELECT id FROM products WHERE business_id = ${businessId})` as SQL_;
  }
  if (spec.name === "variant_values") {
    return sql`variant_id IN (SELECT id FROM product_variants WHERE business_id = ${businessId})` as SQL_;
  }
  return undefined;
}
type SQL_ = ReturnType<typeof sql>;

async function exportTable(
  spec: BackupTableSpec,
  businessId: number,
): Promise<AnyRow[]> {
  const cols = getTableColumns(spec.table as never) as Record<
    string,
    { name: string }
  >;
  let query = db.select().from(spec.table as never).$dynamic();
  const scope = scopeSql(spec, businessId);
  if (scope) query = query.where(scope as never);
  const firstKey = spec.conflictTarget?.[0];
  const orderCol = cols["id"] ?? (firstKey ? cols[firstKey] : undefined);
  if (orderCol) query = query.orderBy(asc(orderCol as never));
  const rows = (await query) as AnyRow[];
  if (!spec.exportExclude?.length) return rows;
  return rows.map((row) => {
    const clone = { ...row };
    for (const prop of spec.exportExclude ?? []) clone[prop] = null;
    // Generated columns never enter the package (they are recomputed).
    for (const prop of spec.generatedExclude ?? []) delete clone[prop];
    return clone;
  });
}

async function countTable(
  spec: BackupTableSpec,
  businessId: number,
): Promise<number> {
  const scope = scopeSql(spec, businessId);
  const result = await db.execute(
    sql`SELECT count(*)::int AS count FROM ${spec.table} ${scope ? sql`WHERE ${scope}` : sql``}`,
  );
  const rows = (result as unknown as { rows?: Array<{ count: number }> }).rows ?? (result as unknown as Array<{ count: number }>);
  return Number(rows[0]?.count ?? 0);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

/** Public: build a complete encrypted package for one business. */
export async function buildBackupPackage(opts: {
  businessId: number;
  type: string;
  moduleKeys: string[];
  filePath: string;
  onProgress?: (stage: string, done: number, total: number) => void;
}): Promise<BuiltPackage & { business: BusinessRow }> {
  const { businessId, filePath } = opts;
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!business) throw new Error("Business not found for backup.");

  const groups = MODULE_GROUPS.filter((g) => opts.moduleKeys.includes(g.key));
  const tableNames = groups.flatMap((g) => g.tables);

  // Attachment metadata (bytes are fetched per row below).
  const attachmentSpecs = Object.keys(ATTACHMENT_TABLES).filter((t) =>
    tableNames.includes(t),
  );
  const attachmentRows: Array<{ table: string; row: AnyRow }> = [];
  for (const t of attachmentSpecs) {
    const spec = TABLE_SPECS[t]!;
    attachmentRows.push(
      ...(await exportTable(spec, businessId)).map((row) => ({
        table: t,
        row,
      })),
    );
  }

  opts.onProgress?.("counting", 0, tableNames.length + 2);
  const recordCounts: Record<string, number> = {};
  let done = 0;
  for (const name of tableNames) {
    recordCounts[name] = await countTable(TABLE_SPECS[name]!, businessId);
    opts.onProgress?.("counting", ++done, tableNames.length + 2);
  }

  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    application: "ezpos",
    appVersion: resolveAppVersion(),
    businessId,
    businessName: business.name,
    businessSlug: business.slug,
    businessTimezone: (business as unknown as { timezone?: string }).timezone ?? null,
    createdAt: new Date().toISOString(),
    type: opts.type,
    modules: groups.map((g) => g.key),
    recordCounts,
    attachmentCounts: Object.fromEntries(
      attachmentSpecs.map((t) => [
        t,
        attachmentRows.filter((r) => r.table === t).length,
      ]),
    ),
    attachments: [],
    warnings: [],
    checksums: {},
    encryption: {
      alg: "AES-256-GCM",
      keyVersion: env.backupEncryptionKeyVersion,
    },
    completion: "complete",
  };

  // --- stream: pack → gzip → encrypt → sha256 tap → file -------------------
  const { pack } = await import("tar-stream");
  const encryptor = createPackageEncryptor();
  const packStream = pack();
  const hash = createHash("sha256");
  let size = 0;
  const out = createWriteStream(filePath);

  const tapped = new PassThrough();
  tapped.on("data", (chunk: unknown) => {
    const buf = chunk as Buffer;
    hash.update(buf);
    size += buf.length;
  });

  // streamx Readable → node Transform chain (streamx supports node pipes).
  const gz = zlib.createGzip();
  (packStream as unknown as import("node:stream").Readable).pipe(gz);
  gz.pipe(encryptor.stream);
  encryptor.stream.pipe(tapped);
  tapped.pipe(out);

  const addEntry = async (
    name: string,
    content: Buffer,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      packStream.entry({ name, size: content.length }, content, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

  const metadata = {
    generatedBy: "ezpos-backend",
    formatVersion: BACKUP_FORMAT_VERSION,
    keyConvention:
      "Row objects keyed by ORM property names; timestamps serialized as ISO strings.",
    exportedAt: manifest.createdAt,
    businessTimezone: manifest.businessTimezone,
  };

  await addEntry("metadata.json", Buffer.from(stableStringify(metadata), "utf8"));

  // Business profile row (business settings are business data; slug and
  // platform status are stripped — see PROFILE_EXCLUDE).
  const profileRow: Record<string, unknown> = { ...business };
  for (const prop of ["id", ...PROFILE_EXCLUDE]) delete profileRow[prop];
  const profileName = "data/_profile.json";
  const profileContent = Buffer.from(stableStringify([profileRow]), "utf8");
  manifest.checksums[profileName] = createHash("sha256").update(profileContent).digest("hex");
  manifest.recordCounts["_profile"] = 1;
  await addEntry(profileName, profileContent);

  // Data files, module-group order (restore order). manifest.json is written
  // LAST so its checksum table covers every entry in the package.
  for (const group of groups) {
    for (const tableName of group.tables) {
      const spec = TABLE_SPECS[tableName]!;
      opts.onProgress?.(`export:${tableName}`, done, tableNames.length + 2);
      const rows = await exportTable(spec, businessId);
      const name = `data/${tableName}.json`;
      const content = Buffer.from(stableStringify(rows), "utf8");
      manifest.checksums[name] = createHash("sha256").update(content).digest("hex");
      await addEntry(name, content);
    }
  }

  // Attachment bytes.
  for (const { table, row } of attachmentRows) {
    const cfg = ATTACHMENT_TABLES[table]!;
    const objectKey = String(row[cfg.keyCol] ?? "");
    if (!objectKey) continue;
    opts.onProgress?.(`attachment:${table}`, done, tableNames.length + 2);
    const bytes = await fetchAttachmentBytes(objectKey);
    if (!bytes) {
      manifest.warnings.push(
        `Attachment bytes unavailable in storage: ${objectKey}`,
      );
      continue;
    }
    const tarPath = `${cfg.tarPrefix}/${objectKey.split("/").pop()}`;
    manifest.attachments.push({
      table,
      id: Number(row[cfg.idCol] ?? 0),
      objectKey,
      path: tarPath,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    manifest.checksums[tarPath] = manifest.attachments.at(-1)!.sha256;
    await addEntry(tarPath, bytes);
  }

  await addEntry(
    "manifest.json",
    Buffer.from(stableStringify(manifest), "utf8"),
  );

  await new Promise<void>((resolve, reject) => {
    packStream.finalize();
    out.on("finish", () => resolve());
    out.on("error", reject);
  });

  opts.onProgress?.("finalizing", tableNames.length + 2, tableNames.length + 2);

  return {
    filePath,
    fileName: `ezpos-backup-${business.slug}-${manifest.createdAt.slice(0, 10)}.ezbackup`,
    size,
    sha256: hash.digest("hex"),
    manifest,
    envelope: { header: encryptor.header },
    business,
  };
}

// ---------------------------------------------------------------------------
// Reader / verifier
// ---------------------------------------------------------------------------

export interface ParsedPackage {
  manifest: BackupManifest;
  metadata: Record<string, unknown> | null;
  rows: Record<string, AnyRow[]> | null;
  attachments: Map<string, Buffer> | null;
}

const ENTRY_RE =
  /^(manifest\.json|metadata\.json|data\/[a-z0-9_]+\.json|attachments\/[A-Za-z0-9._-]+)$/;
const MAX_ENTRIES = 5_000;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB guard

/** Reads (and optionally verifies checksums of) a package from disk. */
export async function readBackupPackage(
  filePath: string,
  opts: { withData?: boolean; loadAttachments?: boolean } = {},
): Promise<ParsedPackage> {
  const { withData = false, loadAttachments = false } = opts;
  let parsedManifest: BackupManifest | null = null;
  let metadata: Record<string, unknown> | null = null;
  const rows: Record<string, AnyRow[]> = {};
  const attachments = new Map<string, Buffer>();
  const seenChecksums = new Map<string, string>();
  let entries = 0;
  let totalBytes = 0;

  const { extract } = await import("tar-stream");
  const ex = extract();
  const gunzip = zlib.createGunzip();
  const decryptor = createPackageDecryptor();

  const done = new Promise<void>((resolve, reject) => {
    ex.on("entry", (header, stream, next) => {
      entries++;
      if (entries > MAX_ENTRIES) {
        next(new Error("Backup package has too many entries."));
        return;
      }
      const name = header.name;
      if (!ENTRY_RE.test(name)) {
        stream.resume();
        next(new Error(`Illegal entry in backup package: ${name}`));
        return;
      }
      const size = Number(header.size ?? 0);
      totalBytes += size;
      if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
        stream.resume();
        next(new Error("Backup package exceeds the uncompressed size limit."));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (c: unknown) => chunks.push(c as Buffer));
      stream.on("end", () => {
        try {
          const content = Buffer.concat(chunks);
          const isData = name.startsWith("data/");
          const isAttachment = name.startsWith("attachments/");
          if (isData || isAttachment) {
            seenChecksums.set(name, createHash("sha256").update(content).digest("hex"));
          }
          if (name === "manifest.json") {
            parsedManifest = JSON.parse(content.toString("utf8")) as BackupManifest;
          } else if (name === "metadata.json") {
            metadata = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
          } else if (isData && withData) {
            rows[name.slice("data/".length).replace(/\.json$/, "")] = JSON.parse(
              content.toString("utf8"),
            ) as AnyRow[];
          } else if (isAttachment && loadAttachments) {
            attachments.set(name, content);
          }
          next();
        } catch (err) {
          next(err as Error);
        }
      });
      stream.on("error", (err: Error) => next(err));
    });
    ex.on("finish", () => resolve());
    ex.on("error", reject);
  });

  // The pipeline is the error source of truth; keep 'done' from becoming an
  // unhandled rejection when the stream fails mid-parse.
  done.catch(() => {});
  await pipelineStreams(
    createReadStream(filePath),
    decryptor,
    gunzip,
    ex,
  );
  await done;

  const manifest = parsedManifest as BackupManifest | null;
  if (!manifest) {
    throw new Error("Backup package is missing manifest.json.");
  }
  if (manifest.completion !== "complete") {
    throw new Error("Backup package is incomplete (never finished writing).");
  }
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Unsupported backup format version ${manifest.formatVersion}.`,
    );
  }
  // Post-hoc checksum verification (manifest is the last tar entry).
  for (const [name, expected] of Object.entries(manifest.checksums ?? {})) {
    const actual = seenChecksums.get(name);
    if (actual === undefined) {
      throw new Error(`Package is missing entry ${name} listed in the manifest.`);
    }
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${name} — package is corrupted.`);
    }
  }
  for (const name of seenChecksums.keys()) {
    if (!(name in (manifest.checksums ?? {}))) {
      throw new Error(`Unexpected extra entry ${name} not covered by the manifest.`);
    }
  }
  return {
    manifest,
    metadata,
    rows: withData ? rows : null,
    attachments: loadAttachments ? attachments : null,
  };
}

/** pipes node + streamx streams with proper error propagation. */
async function pipelineStreams(
  ...streams: unknown[]
): Promise<void> {
  const { pipeline } = await import("node:stream/promises");
  await pipeline(...(streams as unknown as Parameters<typeof pipeline>));
}
