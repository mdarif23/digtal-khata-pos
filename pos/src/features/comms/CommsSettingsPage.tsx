import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getCommSettingsApi,
  getWebhookSecretApi,
  listMessagesApi,
  listProvidersApi,
  listTemplatesApi,
  putCommSettingsApi,
  putProviderApi,
  putTemplateApi,
  type CommChannel,
  type CommMessageRow,
  type CommProvider,
  type CommSettings,
  type CommTemplate,
} from "./comms.api";

function extractError(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: { data?: { message?: string } } }).response
      ?.data?.message === "string"
  ) {
    return (error as { response: { data: { message: string } } }).response.data
      .message;
  }
  return fallback;
}

const PROVIDER_KEYS: Record<CommChannel, { value: string; label: string }[]> = {
  sms: [
    { value: "console", label: "Console (dev)" },
    { value: "generic_http", label: "HTTP gateway (BD SMS)" },
  ],
  whatsapp: [
    { value: "console", label: "Console (dev)" },
    { value: "whatsapp_cloud", label: "WhatsApp Business Cloud (official)" },
  ],
  email: [
    { value: "console", label: "Console (dev)" },
    { value: "resend", label: "Resend" },
  ],
};

/**
 * Communication settings (Phase 2C): per-channel providers with encrypted
 * configs (masked previews only), message templates, policy toggles, the
 * webhook signing secret and the delivery message log.
 */
export function CommsSettingsPage() {
  const [providers, setProviders] = useState<CommProvider[] | null>(null);
  const [templates, setTemplates] = useState<CommTemplate[] | null>(null);
  const [settings, setSettings] = useState<CommSettings | null>(null);
  const [messages, setMessages] = useState<CommMessageRow[] | null>(null);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<CommTemplate | null>(null);
  const [newProvider, setNewProvider] = useState({
    channel: "sms" as CommChannel,
    providerKey: "generic_http",
    url: "",
    apiKey: "",
  });
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, t, s, m] = await Promise.all([
        listProvidersApi(),
        listTemplatesApi(),
        getCommSettingsApi(),
        listMessagesApi({ limit: 50 }),
      ]);
      setProviders(p);
      setTemplates(t);
      setSettings(s);
      setMessages(m.rows);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to load comms settings."), type: "error" });
      setProviders([]);
      setTemplates([]);
      setMessages([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveProvider() {
    try {
      const config: Record<string, unknown> =
        newProvider.providerKey === "generic_http"
          ? { url: newProvider.url, apiKey: newProvider.apiKey, method: "POST" }
          : {};
      await putProviderApi({
        channel: newProvider.channel,
        providerKey: newProvider.providerKey,
        displayName: null,
        config,
        isDefault: true,
        isActive: true,
      });
      setProviderDialogOpen(false);
      setProviders(await listProvidersApi());
      toast.add({ title: "Provider saved (config encrypted).", type: "success" });
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to save the provider."), type: "error" });
    }
  }

  async function saveTemplate(template: CommTemplate) {
    try {
      await putTemplateApi({
        templateKey: template.templateKey,
        channel: template.channel,
        name: template.name,
        body: template.body,
        isActive: template.isActive,
      });
      setTemplates(await listTemplatesApi());
      toast.add({ title: "Template saved.", type: "success" });
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to save the template."), type: "error" });
    }
  }

  async function saveSettings(patch: Partial<CommSettings>) {
    try {
      setSettings(await putCommSettingsApi(patch));
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to save settings."), type: "error" });
    }
  }

  async function showWebhookSecret() {
    try {
      setWebhookSecret(await getWebhookSecretApi());
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to fetch the secret."), type: "error" });
    }
  }

  if (providers === null || templates === null || settings === null || messages === null) {
    return (
      <div className="grid gap-3 p-4 lg:p-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="grid gap-5 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold">Customer communication</h1>
        <p className="text-sm text-muted-foreground">
          WhatsApp / SMS / email providers, templates, consent policy and the
          delivery log. Provider secrets are encrypted and never leave the
          server.
        </p>
      </div>

      {/* Providers */}
      <section className="grid gap-3 rounded-md border p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Providers</h2>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setProviderDialogOpen(true)}>
            <Plus className="size-4" /> Add provider
          </Button>
        </div>
        {providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No providers configured — messages use the dev console.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">Channel</th>
                  <th className="p-2 font-medium">Provider</th>
                  <th className="p-2 font-medium">Default</th>
                  <th className="p-2 font-medium">Config</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="p-2">{p.channel}</td>
                    <td className="p-2 font-mono text-xs">{p.providerKey}</td>
                    <td className="p-2">
                      <Badge variant={p.isDefault ? "default" : "secondary"}>
                        {p.isDefault ? "default" : "—"}
                      </Badge>
                    </td>
                    <td className="p-2 font-mono text-xs text-muted-foreground">
                      {p.configPreview
                        ? JSON.stringify(p.configPreview).slice(0, 80)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Policy */}
      <section className="grid gap-3 rounded-md border p-4">
        <h2 className="font-medium">Policy</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">Auto e-receipt after sale</div>
              <p className="text-xs text-muted-foreground">
                Sends the receipt to the customer's phone (SMS) or email.
              </p>
            </div>
            <Switch
              checked={settings.autoReceiptEnabled}
              onCheckedChange={(v) => void saveSettings({ autoReceiptEnabled: v })}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">Due reminders (daily sweep)</div>
              <p className="text-xs text-muted-foreground">
                One reminder per customer per day; respects opt-out.
              </p>
            </div>
            <Switch
              checked={settings.dueRemindersEnabled}
              onCheckedChange={(v) => void saveSettings({ dueRemindersEnabled: v })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="comms-cap">Daily message cap per customer</Label>
            <Input
              id="comms-cap"
              type="number"
              min={0}
              max={50}
              className="w-28"
              value={settings.dailyCapPerCustomer}
              onChange={(e) =>
                void saveSettings({ dailyCapPerCustomer: Number(e.target.value) || 0 })
              }
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Delivery webhook secret</Label>
            <Button
              size="sm"
              variant="outline"
              className="w-fit gap-1.5"
              onClick={() => void showWebhookSecret()}
            >
              <KeyRound className="size-4" /> Reveal / regenerate
            </Button>
            {webhookSecret ? (
              <p className="break-all rounded-md bg-muted p-2 font-mono text-xs">
                {webhookSecret}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {/* Templates */}
      <section className="grid gap-3 rounded-md border p-4">
        <h2 className="font-medium">Templates</h2>
        {templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Using built-in defaults — save overrides here.
          </p>
        ) : (
          <div className="grid gap-2">
            {templates.map((t) => (
              <div key={t.id} className="grid gap-1.5 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {t.templateKey} <Badge variant="outline">{t.channel}</Badge>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void saveTemplate(t)}>
                    Save
                  </Button>
                </div>
                <Input
                  value={t.body}
                  onChange={(e) =>
                    setTemplates(
                      templates.map((x) =>
                        x.id === t.id ? { ...x, body: e.target.value } : x,
                      ),
                    )
                  }
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Message log */}
      <section className="grid gap-3 rounded-md border p-4">
        <h2 className="font-medium">Message log</h2>
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages sent yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">When</th>
                  <th className="p-2 font-medium">To</th>
                  <th className="p-2 font-medium">Template</th>
                  <th className="p-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id} className="border-t">
                    <td className="p-2 text-xs text-muted-foreground">
                      {new Date(m.createdAt).toLocaleString()}
                    </td>
                    <td className="p-2">{m.recipient}</td>
                    <td className="p-2 font-mono text-xs">{m.templateKey}</td>
                    <td className="p-2">
                      <Badge
                        variant={
                          m.status === "sent"
                            ? "default"
                            : m.status === "failed"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {m.status}
                      </Badge>
                      {m.error ? (
                        <span className="ml-1 text-xs text-destructive">{m.error}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Add provider dialog */}
      <Dialog open={providerDialogOpen} onOpenChange={setProviderDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add provider</DialogTitle>
            <DialogDescription>
              Configs are encrypted at rest; only masked previews are shown
              afterwards. Set the default provider per channel.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>Channel</Label>
              <select
                className="rounded-md border bg-background p-2 text-sm"
                value={newProvider.channel}
                onChange={(e) => {
                  const channel = e.target.value as CommChannel;
                  setNewProvider({
                    ...newProvider,
                    channel,
                    providerKey: PROVIDER_KEYS[channel][0]!.value,
                  });
                }}
              >
                <option value="sms">SMS</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Email</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label>Provider</Label>
              <select
                className="rounded-md border bg-background p-2 text-sm"
                value={newProvider.providerKey}
                onChange={(e) =>
                  setNewProvider({ ...newProvider, providerKey: e.target.value })
                }
              >
                {PROVIDER_KEYS[newProvider.channel].map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            {newProvider.providerKey === "generic_http" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="prov-url">Gateway URL ({"{{recipient}} {{body}}"})</Label>
                  <Input
                    id="prov-url"
                    value={newProvider.url}
                    onChange={(e) => setNewProvider({ ...newProvider, url: e.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="prov-key">API key / token</Label>
                  <Input
                    id="prov-key"
                    type="password"
                    value={newProvider.apiKey}
                    onChange={(e) => setNewProvider({ ...newProvider, apiKey: e.target.value })}
                  />
                </div>
              </>
            ) : null}
            {newProvider.providerKey === "whatsapp_cloud" ? (
              <p className="text-xs text-muted-foreground">
                Requires a Meta WhatsApp Business Cloud phone number ID and
                access token — configure them via the API (PUT
                /api/comms/providers) with {"{"}phoneNumberId, accessToken{"}"}.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button onClick={() => void saveProvider()}>Save provider</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
