import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { supportTicketMessages } from "../../db/schema/supportTickets.js";
import { supportTickets } from "../../db/schema/supportTickets.js";
import { users } from "../../db/schema/users.js";
import { NotFoundError } from "../../utils/handleError.js";
import type { CreateTicketInput, TicketMessageInput } from "../subscriptions/subscriptions.validation.js";

/**
 * Customer-portal side of support: users see and reply to their OWN tickets
 * only. Ownership violations return the same "not found" as a missing
 * ticket — another user's ticket existence is never revealed.
 */

export interface TicketSummary {
  id: number;
  subject: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
}

export async function listUserTickets(userId: number): Promise<TicketSummary[]> {
  const tickets = await db
    .select({
      id: supportTickets.id,
      subject: supportTickets.subject,
      status: supportTickets.status,
      createdAt: supportTickets.createdAt,
      updatedAt: supportTickets.updatedAt,
    })
    .from(supportTickets)
    .where(eq(supportTickets.userId, userId))
    .orderBy(desc(supportTickets.id))
    .limit(100);
  if (tickets.length === 0) return [];

  const counts = await db
    .select({
      ticketId: supportTicketMessages.ticketId,
      count: sql<number>`count(*)::int`,
    })
    .from(supportTicketMessages)
    .where(
      inArray(
        supportTicketMessages.ticketId,
        tickets.map((t) => t.id),
      ),
    )
    .groupBy(supportTicketMessages.ticketId);
  const byTicket = new Map(counts.map((row) => [row.ticketId, row.count]));

  return tickets.map((ticket) => ({
    ...ticket,
    messageCount: byTicket.get(ticket.id) ?? 0,
  }));
}

export async function createTicketForUser(
  userId: number,
  input: CreateTicketInput,
): Promise<TicketSummary> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({
        fullName: users.fullName,
        email: users.email,
        phone: users.phone,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) {
      throw new NotFoundError("Account not found.");
    }

    const [ticket] = await tx
      .insert(supportTickets)
      .values({
        userId,
        businessId: input.businessId ?? null,
        name: user.fullName,
        email: user.email,
        phone: user.phone,
        subject: input.subject,
        message: input.message,
        source: "portal",
        status: "open",
        category: input.category ?? "general",
        priority: input.priority ?? "normal",
      })
      .returning({
        id: supportTickets.id,
        subject: supportTickets.subject,
        status: supportTickets.status,
        category: supportTickets.category,
        priority: supportTickets.priority,
        createdAt: supportTickets.createdAt,
        updatedAt: supportTickets.updatedAt,
      });
    if (!ticket) {
      throw new Error("Ticket insert returned no row.");
    }
    await tx.insert(supportTicketMessages).values({
      ticketId: ticket.id,
      authorType: "customer",
      authorUserId: userId,
      body: input.message,
    });
    return { ...ticket, messageCount: 1 };
  });
}

export interface TicketMessage {
  id: number;
  authorType: string;
  body: string;
  createdAt: Date;
}

export interface TicketDetail {
  id: number;
  subject: string;
  status: string;
  createdAt: Date;
  messages: TicketMessage[];
}

export async function getTicketForUser(
  userId: number,
  ticketId: number,
): Promise<TicketDetail> {
  const [ticket] = await db
    .select({
      id: supportTickets.id,
      subject: supportTickets.subject,
      status: supportTickets.status,
      createdAt: supportTickets.createdAt,
      userId: supportTickets.userId,
    })
    .from(supportTickets)
    .where(
      and(eq(supportTickets.id, ticketId), eq(supportTickets.userId, userId)),
    );
  if (!ticket) {
    throw new NotFoundError("Ticket not found.");
  }
  const messages = await db
    .select({
      id: supportTicketMessages.id,
      authorType: supportTicketMessages.authorType,
      body: supportTicketMessages.body,
      createdAt: supportTicketMessages.createdAt,
    })
    .from(supportTicketMessages)
    .where(eq(supportTicketMessages.ticketId, ticketId))
    .orderBy(asc(supportTicketMessages.id));
  return {
    id: ticket.id,
    subject: ticket.subject,
    status: ticket.status,
    createdAt: ticket.createdAt,
    messages,
  };
}

export async function addTicketMessage(
  userId: number,
  ticketId: number,
  input: TicketMessageInput,
): Promise<TicketMessage> {
  return db.transaction(async (tx) => {
    const [ticket] = await tx
      .select({ id: supportTickets.id, status: supportTickets.status })
      .from(supportTickets)
      .where(
        and(eq(supportTickets.id, ticketId), eq(supportTickets.userId, userId)),
      );
    if (!ticket) {
      throw new NotFoundError("Ticket not found.");
    }

    const [message] = await tx
      .insert(supportTicketMessages)
      .values({
        ticketId,
        authorType: "customer",
        authorUserId: userId,
        body: input.body,
      })
      .returning({
        id: supportTicketMessages.id,
        authorType: supportTicketMessages.authorType,
        body: supportTicketMessages.body,
        createdAt: supportTicketMessages.createdAt,
      });
    if (!message) {
      throw new Error("Ticket message insert returned no row.");
    }

    // A customer reply reopens a resolved ticket and pends a closed one.
    if (ticket.status === "resolved" || ticket.status === "closed") {
      await tx
        .update(supportTickets)
        .set({ status: "open", updatedAt: new Date() })
        .where(eq(supportTickets.id, ticketId));
    } else {
      await tx
        .update(supportTickets)
        .set({ updatedAt: new Date() })
        .where(eq(supportTickets.id, ticketId));
    }
    return message;
  });
}
