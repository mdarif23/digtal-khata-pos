import { z } from "zod";
import { ALL_MODULE_KEYS } from "./backupModules.js";

export const moduleKeysSchema = z
  .array(z.enum(ALL_MODULE_KEYS as [string, ...string[]]))
  .min(1)
  .optional()
  .nullable();

export const createBackupSchema = z.object({
  modules: moduleKeysSchema,
});

export const listBackupsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  type: z
    .enum(["manual", "scheduled", "safety", "pre_restore", "upload"])
    .optional(),
  status: z
    .enum(["pending", "running", "completed", "failed", "expired", "deleted"])
    .optional(),
});

export const restorePreviewSchema = z.object({
  backupId: z.coerce.number().int().positive(),
  mode: z.enum(["full", "new_business", "selective"]),
  modules: moduleKeysSchema,
});

export const restoreSchema = z.object({
  backupId: z.coerce.number().int().positive(),
  mode: z.enum(["full", "new_business", "selective"]),
  modules: moduleKeysSchema,
  confirm: z.literal("RESTORE"),
});

export const registerUploadSchema = z.object({
  storageKey: z.string().min(1).max(500),
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(250)
    .regex(/\.ezbackup$/i, "Only .ezbackup packages can be registered."),
});

export const scheduleSchema = z
  .object({
    enabled: z.boolean(),
    frequency: z.enum(["daily", "weekly"]),
    hour: z.number().int().min(0).max(23).default(2),
    dayOfWeek: z.number().int().min(0).max(6).optional().nullable(),
    retentionDays: z.number().int().min(1).max(365).default(30),
  })
  .refine(
    (v) => v.frequency === "daily" || v.dayOfWeek !== undefined && v.dayOfWeek !== null,
    { message: "Weekly schedules need a day of week.", path: ["dayOfWeek"] },
  );

export type CreateBackupInput = z.infer<typeof createBackupSchema>;
export type RestoreInput = z.infer<typeof restoreSchema>;
export type ScheduleInput = z.infer<typeof scheduleSchema>;
