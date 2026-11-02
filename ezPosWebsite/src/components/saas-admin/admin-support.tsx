"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextareaField } from "@/components/forms/textarea-field";
import {
  adminReplyTicket,
  adminSetTicketStatus,
  fetchAdminTicket,
  fetchAdminTickets,
  type AdminTicket,
  type AdminTicketDetail,
} from "@/lib/api/saas-admin";

const STATUSES = ["open", "pending", "resolved", "closed"] as const;

export function AdminSupport() {
  const [tickets, setTickets] = useState<AdminTicket[] | null>(null);
  const [selected, setSelected] = useState<AdminTicketDetail | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (selectId?: number) => {
    const result = await fetchAdminTickets();
    setTickets(result.data ?? []);
    if (selectId) {
      const detail = await fetchAdminTicket(selectId);
      if (detail.ok && detail.data) setSelected(detail.data);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await reload();
    })();
  }, [reload]);

  async function sendReply() {
    if (!selected || reply.trim() === "") return;
    setBusy(true);
    await adminReplyTicket(selected.id, reply.trim());
    setBusy(false);
    setReply("");
    await reload(selected.id);
  }

  async function changeStatus(status: (typeof STATUSES)[number]) {
    if (!selected) return;
    setBusy(true);
    await adminSetTicketStatus(selected.id, status);
    setBusy(false);
    await reload(selected.id);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">
          Support
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Tickets from the public contact form and the customer portal.
          Replying marks a ticket pending (awaiting customer).
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <h3 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
            All tickets
          </h3>
          {tickets === null ? (
            <p className="px-5 py-6 text-sm text-slate-500">Loading…</p>
          ) : tickets.length === 0 ? (
            <p className="px-5 py-6 text-sm text-slate-500">No tickets.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {tickets.map((ticket) => (
                <li key={ticket.id}>
                  <button
                    type="button"
                    className={
                      selected?.id === ticket.id
                        ? "w-full px-5 py-3 text-left bg-indigo-50"
                        : "w-full px-5 py-3 text-left hover:bg-slate-50"
                    }
                    onClick={() => {
                      setSelected(null);
                      void (async () => {
                        const detail = await fetchAdminTicket(ticket.id);
                        if (detail.ok && detail.data) setSelected(detail.data);
                      })();
                    }}
                  >
                    <p className="text-sm font-medium text-slate-900">
                      {ticket.subject}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {ticket.name} ({ticket.source}) · {ticket.status} ·{" "}
                      {new Date(ticket.updatedAt).toLocaleDateString()}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          {!selected ? (
            <p className="px-6 py-10 text-center text-sm text-slate-500">
              Select a ticket to work it.
            </p>
          ) : (
            <div className="flex h-full flex-col">
              <div className="border-b border-slate-100 px-6 py-4">
                <p className="text-sm font-semibold text-slate-900">
                  {selected.subject}
                </p>
                <p className="text-xs text-slate-500">
                  {selected.name} · {selected.email} · {selected.status}
                </p>
                <div className="mt-2 flex gap-1.5">
                  {STATUSES.map((status) => (
                    <Button
                      key={status}
                      size="sm"
                      variant={selected.status === status ? "primary" : "outline"}
                      disabled={busy}
                      onClick={() => void changeStatus(status)}
                    >
                      {status}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
                {selected.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={
                      msg.authorType === "admin"
                        ? "ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-50 px-4 py-3 text-sm text-indigo-900"
                        : "mr-auto max-w-[85%] rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-3 text-sm text-slate-900"
                    }
                  >
                    <p className="whitespace-pre-wrap">{msg.body}</p>
                    <p className="mt-1 text-right text-[10px] uppercase tracking-wide opacity-60">
                      {msg.authorType} · {new Date(msg.createdAt).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-100 p-4">
                <TextareaField
                  id="admin-ticket-reply"
                  label="Reply as ezPos team"
                  rows={3}
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                />
                <Button
                  className="mt-3"
                  onClick={sendReply}
                  disabled={busy || reply.trim() === ""}
                >
                  {busy ? "Sending…" : "Send reply"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
