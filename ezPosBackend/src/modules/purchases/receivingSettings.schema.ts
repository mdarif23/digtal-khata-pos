import { z } from "zod";

export const updateReceivingSettingsSchema = z.object({
  overReceiveTolerancePercent: z.number().min(0).max(100),
});

export type UpdateReceivingSettingsInput = z.infer<
  typeof updateReceivingSettingsSchema
>;
