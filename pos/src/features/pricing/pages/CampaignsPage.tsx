import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { StatusBadge } from "@/components/common/StatusBadge";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "@/components/ui/toast";
import { extractApiError } from "../components/RuleDialog";
import {
  useCampaigns,
  useCreateCampaign,
  useDeleteCampaign,
  useUpdateCampaign,
} from "../hooks/usePricing";
import type { Campaign } from "../pricing.types";

/**
 * Promotional campaigns (Bundle & Combo Phase 4): seasonal groupings that
 * GATE their promotions — an inactive or expired campaign silently
 * suppresses every promotion attached to it — and break priority ties
 * between same-priority promotions. Campaigns organize rules; they never
 * duplicate pricing logic.
 */
export function CampaignsPage() {
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("promotions.manage");
  const campaignsQuery = useCampaigns();
  const createCampaign = useCreateCampaign();
  const updateCampaign = useUpdateCampaign();
  const deleteCampaign = useDeleteCampaign();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Campaign | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [priority, setPriority] = useState("0");
  const [isActive, setIsActive] = useState(true);

  function openCreate() {
    setEditing(null);
    setName("");
    setDescription("");
    setStartsAt("");
    setEndsAt("");
    setPriority("0");
    setIsActive(true);
    setDialogOpen(true);
  }

  function openEdit(campaign: Campaign) {
    setEditing(campaign);
    setName(campaign.name);
    setDescription(campaign.description ?? "");
    setStartsAt(campaign.startsAt ? campaign.startsAt.slice(0, 10) : "");
    setEndsAt(campaign.endsAt ? campaign.endsAt.slice(0, 10) : "");
    setPriority(String(campaign.priority ?? 0));
    setIsActive(campaign.isActive);
    setDialogOpen(true);
  }

  async function save() {
    if (!name.trim()) {
      toast.add({
        type: "error",
        description: "A campaign name is required.",
        priority: "high",
      });
      return;
    }
    const payload = {
      name: name.trim(),
      description: description.trim() === "" ? null : description.trim(),
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      priority: Number(priority) || 0,
      isActive,
    };
    try {
      if (editing) {
        await updateCampaign.mutateAsync({ id: editing.id, payload });
        toast.add({ type: "success", description: t("pricing:campaignUpdated", { defaultValue: "Campaign updated." }) });
      } else {
        await createCampaign.mutateAsync(payload);
        toast.add({ type: "success", description: t("pricing:campaignCreated", { defaultValue: "Campaign created." }) });
      }
      setDialogOpen(false);
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not save the campaign."),
        priority: "high",
      });
    }
  }

  const rows = campaignsQuery.data ?? [];

  return (
    <PageContainer width="wide">
      <PageHeader
        title={t("pricing:campaigns", { defaultValue: "Campaigns" })}
        description={t("pricing:campaignsDescription", {
          defaultValue:
            "Group promotions into seasonal campaigns. An inactive or expired campaign suppresses its promotions automatically; campaign priority breaks ties between same-priority promotions.",
        })}
        actions={
          canManage ? (
            <Button onClick={openCreate}>
              {t("pricing:newCampaign", { defaultValue: "New campaign" })}
            </Button>
          ) : undefined
        }
      />
      <Card>
        <CardContent>
          {campaignsQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>{t("common:name", { defaultValue: "Name" })}</TableHead>
                    <TableHead>{t("pricing:window", { defaultValue: "Window" })}</TableHead>
                    <TableHead className="text-right">
                      {t("pricing:priority", { defaultValue: "Priority" })}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("pricing:promotions", { defaultValue: "Promotions" })}
                    </TableHead>
                    <TableHead>{t("common:status", { defaultValue: "Status" })}</TableHead>
                    {canManage && <TableHead className="text-right" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={canManage ? 6 : 5}>
                        <EmptyState
                          icon={Megaphone}
                          title={t("pricing:noCampaigns", { defaultValue: "No campaigns yet" })}
                          description={t("pricing:noCampaignsDescription", {
                            defaultValue:
                              "Create a campaign to organize bundles and promotions into seasonal groups.",
                          })}
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((campaign) => (
                      <TableRow key={campaign.id}>
                        <TableCell className="font-medium">
                          {campaign.name}
                          {campaign.description && (
                            <div className="text-xs font-normal text-muted-foreground">
                              {campaign.description}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {campaign.startsAt || campaign.endsAt
                            ? `${campaign.startsAt?.slice(0, 10) ?? "…"} → ${campaign.endsAt?.slice(0, 10) ?? "…"}`
                            : t("pricing:always", { defaultValue: "Always" })}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {campaign.priority}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {campaign.promotionCount}
                        </TableCell>
                        <TableCell>
                          {campaign.isActive ? (
                            <StatusBadge tone="success">
                              {t("common:active", { defaultValue: "Active" })}
                            </StatusBadge>
                          ) : (
                            <StatusBadge tone="neutral">
                              {t("common:inactive", { defaultValue: "Inactive" })}
                            </StatusBadge>
                          )}
                        </TableCell>
                        {canManage && (
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1.5">
                              <Button variant="outline" size="sm" onClick={() => openEdit(campaign)}>
                                {t("common:edit", { defaultValue: "Edit" })}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={updateCampaign.isPending}
                                onClick={() =>
                                  void updateCampaign
                                    .mutateAsync({
                                      id: campaign.id,
                                      payload: { isActive: !campaign.isActive },
                                    })
                                    .catch((err) =>
                                      toast.add({
                                        type: "error",
                                        description: extractApiError(
                                          err,
                                          "Could not update the campaign.",
                                        ),
                                        priority: "high",
                                      }),
                                    )
                                }
                              >
                                {campaign.isActive
                                  ? t("common:deactivate", { defaultValue: "Deactivate" })
                                  : t("common:activate", { defaultValue: "Activate" })}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={deleteCampaign.isPending}
                                onClick={() => setDeleteTarget(campaign)}
                              >
                                {t("common:delete", { defaultValue: "Delete" })}
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("pricing:editCampaign", { defaultValue: "Edit campaign" })
                : t("pricing:newCampaign", { defaultValue: "New campaign" })}
            </DialogTitle>
            <DialogDescription>
              {t("pricing:campaignDialogDescription", {
                defaultValue:
                  "The campaign's window and status gate every promotion attached to it.",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="campaign-name">
                {t("common:name", { defaultValue: "Name" })}
              </Label>
              <Input
                id="campaign-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="campaign-description">
                {t("pricing:description", { defaultValue: "Description" })}
              </Label>
              <Input
                id="campaign-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="campaign-start">
                  {t("pricing:startsAt", { defaultValue: "Starts at" })}
                </Label>
                <Input
                  id="campaign-start"
                  type="date"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="campaign-end">
                  {t("pricing:endsAt", { defaultValue: "Ends at" })}
                </Label>
                <Input
                  id="campaign-end"
                  type="date"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="campaign-priority">
                  {t("pricing:priority", { defaultValue: "Priority" })}
                </Label>
                <Input
                  id="campaign-priority"
                  type="number"
                  min="0"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                />
              </div>
              <div className="flex items-end justify-between rounded-md border p-2">
                <span className="text-sm">{t("common:active", { defaultValue: "Active" })}</span>
                <Switch checked={isActive} onCheckedChange={setIsActive} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("common:cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              onClick={() => void save()}
              disabled={createCampaign.isPending || updateCampaign.isPending}
            >
              {editing
                ? t("common:saveChanges", { defaultValue: "Save changes" })
                : t("pricing:createCampaign", { defaultValue: "Create campaign" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("pricing:deleteCampaignTitle", {
          defaultValue: 'Delete the campaign "{{name}}"?',
          name: deleteTarget?.name ?? "",
        })}
        description={t("pricing:deleteCampaignDescription", {
          defaultValue:
            "Attached promotions survive and keep applying, but they leave the campaign. Sale snapshots keep their attribution.",
        })}
        entityName="campaign"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deleteCampaign.mutateAsync(deleteTarget.id);
        }}
      />
    </PageContainer>
  );
}
