import { z } from "zod";

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

export const createObservationSchema = z.object({
  variantId: z.coerce.number().int().positive(),
  supplierId: z.coerce.number().int().positive(),
  quotedPrice: z.coerce.number().min(0),
  // Package size the quotation refers to (e.g. 25 for a 25 KG sack).
  // Omitted/null = the quoted price is already per unit.
  packageQuantity: z.coerce.number().positive().nullable().optional(),
  observationDate: dateString.optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type CreateObservationInput = z.infer<typeof createObservationSchema>;

export const updateObservationSchema = z.object({
  supplierId: z.coerce.number().int().positive().optional(),
  quotedPrice: z.coerce.number().min(0).optional(),
  packageQuantity: z.coerce.number().positive().nullable().optional(),
  observationDate: dateString.optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type UpdateObservationInput = z.infer<typeof updateObservationSchema>;

export const listObservationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().max(100).optional(),
  variantId: z.coerce.number().int().positive().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  from: dateString.optional(),
  to: dateString.optional(),
});
export type ListObservationsQuery = z.infer<typeof listObservationsQuerySchema>;

export const observationIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});
