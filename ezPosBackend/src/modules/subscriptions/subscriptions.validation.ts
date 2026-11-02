import { z } from "zod";

export const changePlanSchema = z.object({
  planId: z
    .number()
    .int("A valid plan is required")
    .positive("A valid plan is required"),
});

export type ChangePlanInput = z.infer<typeof changePlanSchema>;

export const cancelSubscriptionSchema = z.object({
  immediate: z.boolean().optional(),
});

export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;

export const createTicketSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(3, "Enter a subject")
    .max(200, "Subject is too long"),
  message: z
    .string()
    .trim()
    .min(10, "Please describe your issue (at least 10 characters)")
    .max(5000, "Message is too long"),
  businessId: z.number().int().positive().nullish(),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const ticketMessageSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Enter a message")
    .max(5000, "Message is too long"),
});

export type TicketMessageInput = z.infer<typeof ticketMessageSchema>;
