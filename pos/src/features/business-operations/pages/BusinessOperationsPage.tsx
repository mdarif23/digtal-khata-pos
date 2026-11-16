import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { CheckCircle2, CircleDashed, ExternalLink, Store } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { toast } from "@/components/ui/toast";
import { usePermissions } from "@/hooks/usePermissions";
import { useSessionStore, type BusinessMode } from "@/auth/sessionStore";
import { refreshSessionContext } from "@/api/axios";
import {
  apiErrorMessage,
  type BusinessOperationsSummary,
} from "../businessOperations.api";
import { useBusinessOperations, useChangeBusinessMode } from "../hooks/useBusinessOperations";

const MODE_OPTIONS: {
  value: BusinessMode;
  label: string;
  description: string;
}[] = [
  {
    value: "physical_only",
    label: "Physical shop only",
    description:
      "Counter sales at your store. Online integrations are hidden — no online store needed.",
  },
  {
    value: "online_only",
    label: "Online only",
    description:
      "Sell through WooCommerce or a storefront. No register or counter required — one stock location serves fulfillment.",
  },
  {
    value: "omnichannel",
    label: "Physical + online",
    description:
      "Run the register and online channels side by side on shared inventory.",
  },
];

const WEBSITE_URL =
  import.meta.env.VITE_WEBSITE_URL || "http://localhost:3001";

function ReadinessRow({
  done,
  label,
  hint,
}: {
  done: boolean;
  label: string;
  hint: string;
}) {
  return (
    <li className="flex items-start gap-2.5">
      {done ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600" />
      ) : (
        <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0">
        <p className={done ? "text-sm" : "text-sm font-medium"}>{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </li>
  );
}

function ModeCard({
  option,
  active,
  disabled,
  onSelect,
}: {
  option: (typeof MODE_OPTIONS)[number];
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled || active}
      className={
        active
          ? "flex-1 rounded-xl border-2 border-primary bg-primary/5 p-4 text-left"
          : "flex-1 rounded-xl border border-border p-4 text-left transition-colors hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-60"
      }
    >
      <div className="flex items-center gap-2">
        <Store className="size-4 text-primary" />
        <span className="text-sm font-semibold">{option.label}</span>
        {active ? (
          <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">
            Active
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
        {option.description}
      </p>
    </button>
  );
}

/**
 * Settings → Business Operations: the operating-model switch plus a
 * read-only snapshot of what each channel needs. Switching the mode never
 * creates or deletes data — it only configures which surfaces are active
 * (and auto-provisions one stock location when an online-capable mode is
 * chosen with none existing).
 */
export function BusinessOperationsPage() {
  const { hasPermission } = usePermissions();
  const businessMode = useSessionStore((state) => state.businessMode);
  const queryClient = useQueryClient();
  const operationsQuery = useBusinessOperations();

  const canManage = hasPermission("settings.edit");
  const changeMode = useChangeBusinessMode(async () => {
    toast.add({ type: "success", description: "Business mode updated." });
    // The sidebar/route guards read the mode from the session snapshot.
    await refreshSessionContext();
  });

  const operations: BusinessOperationsSummary | undefined =
    operationsQuery.data;
  const effectiveMode: BusinessMode | null =
    operations?.mode ?? businessMode ?? null;

  async function selectMode(mode: BusinessMode) {
    if (!canManage || mode === effectiveMode) return;
    try {
      await changeMode.mutateAsync(mode);
    } catch (err) {
      toast.add({
        type: "error",
        description: apiErrorMessage(err, "Could not update the business mode."),
        priority: "high",
      });
    }
  }

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Business Operations"
        description="Choose how this business sells. The mode is a configuration, not a permanent type — switch anytime without losing data."
      />

      {operations && operations.subscription.accessMode !== "full" ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            This business is in read-only mode. You can still switch the
            operating model; other changes need an active subscription.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            {MODE_OPTIONS.map((option) => (
              <ModeCard
                key={option.value}
                option={option}
                active={effectiveMode === option.value}
                disabled={!canManage || changeMode.isPending}
                onSelect={() => void selectMode(option.value)}
              />
            ))}
          </div>
          {!canManage ? (
            <p className="text-xs text-muted-foreground">
              Only roles with settings edit permission can change the
              operating model.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {operationsQuery.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : operationsQuery.isError ? (
        <Card>
          <CardContent className="text-sm text-destructive" role="alert">
            Could not load the operations snapshot.{" "}
            <button
              type="button"
              className="font-medium underline underline-offset-2"
              onClick={() => void operationsQuery.refetch()}
            >
              Retry
            </button>
          </CardContent>
        </Card>
      ) : operations ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardContent>
              <h2 className="text-sm font-semibold">Physical store</h2>
              <ul className="mt-3 space-y-3">
                <ReadinessRow
                  done={operations.readiness.stockSourceReady}
                  label="Stock location"
                  hint={`${operations.counts.activeLocations} active location${operations.counts.activeLocations === 1 ? "" : "s"} — every channel fulfills from a location`}
                />
                <ReadinessRow
                  done={operations.readiness.registerReady}
                  label="Register configured"
                  hint={`${operations.counts.activeRegisters} active register${operations.counts.activeRegisters === 1 ? "" : "s"} — counter sales and drawer sessions`}
                />
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <h2 className="text-sm font-semibold">Online selling</h2>
              <ul className="mt-3 space-y-3">
                <ReadinessRow
                  done={operations.readiness.catalogReady}
                  label="Product catalog"
                  hint={`${operations.counts.products} product${operations.counts.products === 1 ? "" : "s"} in the catalog`}
                />
                <ReadinessRow
                  done={operations.readiness.onlineChannelConnected}
                  label="Channel connected"
                  hint={`${operations.counts.connectedChannels} WooCommerce / custom-site integration${operations.counts.connectedChannels === 1 ? "" : "s"}`}
                />
                <ReadinessRow
                  done={operations.readiness.hostedStorefrontCreated}
                  label="Hosted storefront"
                  hint={`${operations.counts.hostedStorefronts} storefront${operations.counts.hostedStorefronts === 1 ? "" : "s"} created (plan permitting)`}
                />
              </ul>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">Related setup:</span>
          <Link
            to="/locations"
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            Locations
          </Link>
          {/* WP-016: mode-appropriate quick links — after switching to
              online-only the register route is mode-blocked and would 403. */}
          {effectiveMode !== "online_only" ? (
            <Link
              to="/register"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              Registers
            </Link>
          ) : null}
          {effectiveMode !== "physical_only" ? (
            <a
              href={`${WEBSITE_URL}/account/integrations`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              Channels & integrations
              <ExternalLink className="size-3.5 text-muted-foreground" />
            </a>
          ) : null}
          {effectiveMode !== "physical_only" ? (
            <a
              href={`${WEBSITE_URL}/account/online-store`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              Hosted storefront
              <ExternalLink className="size-3.5 text-muted-foreground" />
            </a>
          ) : null}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
