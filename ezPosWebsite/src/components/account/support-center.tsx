"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import { TextareaField } from "@/components/forms/textarea-field";
import { useAuth } from "@/components/providers/auth-provider";
import {
  createTicket,
  fetchTicket,
  fetchTickets,
  replyToTicket,
  type TicketDetail,
  type TicketSummary,
} from "@/lib/api/portal";

const statusStyle: Record<string, string> = {
  open: "font-medium text-indigo-700",
  pending: "font-medium text-amber-700",
  resolved: "font-medium text-green-700",
  closed: "font-medium text-slate-500",
};

export function SupportCenter() {
  const { businesses, user } = useAuth();
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [formMessage, setFormMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const businessId = businesses[0]?.businessId ?? null;

  async function reload(selectId?: number) {
    const listResult = await fetchTickets();
    setTickets(listResult.data ?? []);
    if (selectId) {
      const detail = await fetchTicket(selectId);
      setSelected(detail.ok && detail.data ? detail.data : null);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitTicket() {
    setFormMessage(null);
    if (subject.trim().length < 3 || message.trim().length < 10) {
      setFormMessage({ text: "Add a subject and describe your issue (10+ characters).", ok: false });
      return;
    }
    setBusy(true);
    const result = await createTicket({
      subject: subject.trim(),
      message: message.trim(),
      businessId,
    });
    setBusy(false);
    setFormMessage({ text: result.message, ok: result.ok });
    if (result.ok) {
      setSubject("");
      setMessage("");
      await reload(result.data?.id);
    }
  }

  async function sendReply() {
    if (!selected || reply.trim() === "") return;
    setBusy(true);
    const result = await replyToTicket(selected.id, reply.trim());
    setBusy(false);
    if (result.ok) {
      setReply("");
      await reload(selected.id);
    } else {
      setFormMessage({ text: result.message, ok: false });
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Support
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Open a ticket and track the conversation — replies also arrive by
          email.
        </p>
      </div>

      {formMessage ? (
        <Alert tone={formMessage.ok ? "info" : "warning"} title={formMessage.ok ? "Done" : "Please check"}>
          {formMessage.text}
        </Alert>
      ) : null}

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">New ticket</h2>
        <div className="mt-4 space-y-4">
          <TextField
            id="ticket-subject"
            label="Subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="What is this about?"
          />
          <TextareaField
            id="ticket-message"
            label="Message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={`Hi — I'm ${user?.fullName ?? ""}. The issue I'm seeing is…`}
          />
          <Button onClick={submitTicket} disabled={busy}>
            {busy ? "Sending…" : "Create ticket"}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
            Your tickets
          </h2>
          {tickets === null ? (
            <p className="px-5 py-6 text-sm text-slate-500">Loading…</p>
          ) : tickets.length === 0 ? (
            <p className="px-5 py-6 text-sm text-slate-500">
              No tickets yet.
            </p>
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
                        const detail = await fetchTicket(ticket.id);
                        if (detail.ok && detail.data) setSelected(detail.data);
                      })();
                    }}
                  >
                    <p className="text-sm font-medium text-slate-900">
                      {ticket.subject}
                    </p>
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                      <span className={statusStyle[ticket.status] ?? ""}>
                        {ticket.status}
                      </span>
                      · {ticket.messageCount} message
                      {ticket.messageCount === 1 ? "" : "s"} ·{" "}
                      {new Date(ticket.createdAt).toLocaleDateString()}
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
              Select a ticket to read the conversation.
            </p>
          ) : (
            <div className="flex h-full flex-col">
              <div className="border-b border-slate-100 px-6 py-4">
                <p className="text-sm font-semibold text-slate-900">
                  {selected.subject}
                </p>
                <p className={statusStyle[selected.status] ?? "text-xs"}>
                  {selected.status}
                </p>
              </div>
              <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
                {selected.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={
                      msg.authorType === "customer"
                        ? "ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-50 px-4 py-3 text-sm text-indigo-900"
                        : "mr-auto max-w-[85%] rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-3 text-sm text-slate-900"
                    }
                  >
                    <p className="whitespace-pre-wrap">{msg.body}</p>
                    <p className="mt-1 text-right text-[10px] uppercase tracking-wide opacity-60">
                      {msg.authorType === "customer" ? "You" : "ezPos team"} ·{" "}
                      {new Date(msg.createdAt).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-100 p-4">
                <TextareaField
                  id="ticket-reply"
                  label="Reply"
                  rows={3}
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  placeholder="Type your reply…"
                />
                <Button className="mt-3" onClick={sendReply} disabled={busy || reply.trim() === ""}>
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
