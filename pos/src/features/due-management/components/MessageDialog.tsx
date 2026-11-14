import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import {
  templatesFor,
  type MessageContext,
  type MessageTemplateKey,
} from "../lib/messages";
import { normalizeBangladeshPhone, whatsappLink } from "../lib/format";

/**
 * In-session throttle for reminder templates. Reminders are manual sends
 * (copy / WhatsApp); this only prevents hammering the same party with
 * duplicate reminder texts during one app session. Delivery is never
 * assumed — nothing is sent automatically.
 */
const REMINDER_THROTTLE_MS = 30 * 60 * 1000;
const reminderLog = new Map<string, number>();

type MessageTarget = {
  isCustomer: boolean;
  name: string;
  phone: string | null;
  invoiceNumber: string;
  invoiceDate: string | null;
  totalAmount: number;
  outstandingAmount: number;
};

export function MessageDialog({
  target,
  open,
  onOpenChange,
}: {
  target: MessageTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const audience = target?.isCustomer ? "customer" : "supplier";
  const templates = useMemo(() => templatesFor(audience), [audience]);
  const [templateKey, setTemplateKey] = useState<MessageTemplateKey>(
    templates[0]?.key ?? "friendly_reminder",
  );
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open && templates[0]) {
      setTemplateKey(templates[0].key);
      setCopied(false);
    }
  }, [open, templates]);

  const context: MessageContext | null = useMemo(() => {
    if (!target) return null;
    return {
      isCustomer: target.isCustomer,
      name: target.name,
      invoiceNumber: target.invoiceNumber,
      invoiceDate: target.invoiceDate,
      totalAmount: target.totalAmount,
      outstandingAmount: target.outstandingAmount,
    };
  }, [target]);

  const template = templates.find((item) => item.key === templateKey);
  const generatedMessage = context && template ? template.build(context) : "";

  // Track manual edits: switching templates regenerates, otherwise the
  // user's tweaks are preserved.
  const [draft, setDraft] = useState<string | null>(null);
  const message = draft ?? generatedMessage;

  useEffect(() => {
    if (open) setDraft(null);
  }, [open]);

  const reminderThrottled = useMemo(() => {
    if (!target || !template) return false;
    if (template.key !== "friendly_reminder" && template.key !== "overdue_reminder")
      return false;
    const key = `${audience}-${target.invoiceNumber}-${template.key}`;
    const last = reminderLog.get(key);
    return last !== undefined && Date.now() - last < REMINDER_THROTTLE_MS;
  }, [audience, target, template]);

  const phone = normalizeBangladeshPhone(target?.phone);
  const phoneIssue =
    target && !phone
      ? "No valid Bangladeshi mobile number on file (expected e.g. 01712345678)."
      : null;

  if (!target) return null;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message);
    } catch {
      // Fallback for contexts where the clipboard API is unavailable.
      textareaRef.current?.select();
      document.execCommand("copy");
    }
    setCopied(true);
    toast.success("Message copied. Paste it into SMS, Messenger, or WhatsApp.");
  }

  function handleWhatsApp() {
    if (!phone) return;
    if (template) {
      const key = `${audience}-${target.invoiceNumber}-${template.key}`;
      reminderLog.set(key, Date.now());
    }
    window.open(whatsappLink(phone, message), "_blank", "noopener,noreferrer");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Message {target.isCustomer ? "customer" : "supplier"} — {target.name}
          </DialogTitle>
          <DialogDescription>
            The message is generated from verified invoice data. Nothing is sent
            automatically — copy it or open WhatsApp and send it yourself.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="message-template">Template</Label>
            <Select
              value={templateKey}
              onValueChange={(value) =>
                setTemplateKey(value as MessageTemplateKey)
              }
              items={templates.map((template) => ({
                value: template.key,
                label: template.label,
              }))}
            >
              <SelectTrigger id="message-template" className="w-full">
                <SelectValue placeholder="Choose a template" />
              </SelectTrigger>
              <SelectContent>
                {templates.map((item) => (
                  <SelectItem key={item.key} value={item.key}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="message-body">Message</Label>
            <Textarea
              id="message-body"
              ref={textareaRef}
              rows={6}
              value={message}
              onChange={(event) => setDraft(event.target.value)}
              className="font-mono text-xs"
            />
          </div>

          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <p>
              <span className="text-muted-foreground">Phone on file: </span>
              <span className="font-mono">{target.phone ?? "—"}</span>
            </p>
            {phoneIssue ? (
              <p role="alert" className="mt-1 text-sm text-destructive">
                {phoneIssue}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                WhatsApp will open with {`+${phone}`} and the message pre-filled.
                You send it manually.
              </p>
            )}
          </div>

          {reminderThrottled ? (
            <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
              <Timer className="mt-0.5 h-4 w-4 shrink-0" />
              You already used this reminder for this invoice in the last 30
              minutes. Consider a different template or wait before repeating it.
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleCopy}>
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy message"}
            </Button>
            <Button
              type="button"
              disabled={!phone}
              onClick={handleWhatsApp}
              title={phoneIssue ?? undefined}
            >
              <ExternalLink />
              Open WhatsApp
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
