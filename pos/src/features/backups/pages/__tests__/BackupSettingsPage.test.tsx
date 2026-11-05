import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BackupSettingsPage from "../BackupSettingsPage";
import type { BackupRow } from "../../backups.api";

vi.mock("@/api/axios", () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

const backupRow: BackupRow = {
  id: 11,
  businessId: 1,
  type: "manual",
  status: "completed",
  storageKey: "local:x.ezbackup",
  fileName: "ezpos-backup-demo-2026-11-05.ezbackup",
  fileSize: 6400,
  sha256: "abc",
  manifest: {
    formatVersion: 1,
    appVersion: "1.0.0",
    businessId: 1,
    businessName: "Demo",
    businessSlug: "demo",
    createdAt: "2026-11-05T10:00:00.000Z",
    type: "manual",
    modules: ["configuration", "contacts"],
    recordCounts: { customers: 3, locations: 1 },
    attachmentCounts: {},
    warnings: [],
    completion: "complete",
  },
  moduleSelection: null,
  error: null,
  expiresAt: null,
  verifiedAt: "2026-11-05T10:00:05.000Z",
  triggeredBy: 1,
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:05.000Z",
};

vi.mock("../../backups.api", () => ({
  getBackupModulesApi: vi.fn(() =>
    Promise.resolve({
      storageEnabled: false,
      groups: [
        { key: "configuration", label: "Configuration & settings", requires: [], tables: 6 },
        { key: "contacts", label: "Customers & suppliers", requires: ["configuration"], tables: 2 },
      ],
    }),
  ),
  listBackupsApi: vi.fn(() =>
    Promise.resolve({ items: [backupRow], total: 1, page: 1, pageSize: 50 }),
  ),
  getBackupApi: vi.fn(() => Promise.resolve(backupRow)),
  verifyBackupApi: vi.fn(() => Promise.resolve({ verified: true })),
  deleteBackupApi: vi.fn(() => Promise.resolve()),
  createBackupApi: vi.fn(() => Promise.resolve(backupRow)),
  downloadBackupApi: vi.fn(() => Promise.resolve()),
  presignUploadApi: vi.fn(),
  registerUploadApi: vi.fn(),
  previewRestoreApi: vi.fn(),
  restoreApi: vi.fn(),
  getRestoreJobApi: vi.fn(),
  getScheduleApi: vi.fn(() =>
    Promise.resolve({
      schedule: {
        enabled: true,
        frequency: "daily",
        hour: 2,
        dayOfWeek: null,
        retentionDays: 30,
        lastRunAt: null,
        nextRunAt: "2026-11-06T02:00:00.000Z",
      },
      storageEnabled: false,
    }),
  ),
  saveScheduleApi: vi.fn(),
}));

vi.mock("../../../pos/offline/offlineStore", () => ({
  useOfflineStore: (selector: (s: { pendingCount: number }) => number) =>
    selector({ pendingCount: 0 }),
}));
vi.mock("../../../pos/offline/db", () => ({
  listOutbox: vi.fn(() => Promise.resolve([])),
}));

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <BackupSettingsPage />
    </QueryClientProvider>,
  );
}

describe("BackupSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders history rows with type, status and actions", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("completed")).toBeInTheDocument();
    });
    expect(screen.getByText("manual")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restore/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back up now/i })).toBeInTheDocument();
  });

  it("shows the empty state when there are no backups", async () => {
    const { listBackupsApi } = await import("../../backups.api");
    (listBackupsApi as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/no backups yet/i)).toBeInTheDocument();
    });
  });

  it("opens the backup-now dialog and starts a backup", async () => {
    const user = userEvent.setup();
    const { createBackupApi } = await import("../../backups.api");
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: /back up now/i }));
    await user.click(screen.getByRole("button", { name: /back up now/i }));
    await waitFor(() => {
      expect(screen.getByText(/create a backup/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /start backup/i }));
    await waitFor(() => {
      expect(createBackupApi).toHaveBeenCalledWith(null);
    });
  });

  it("details dialog shows record counts and verify action", async () => {
    const user = userEvent.setup();
    const { verifyBackupApi } = await import("../../backups.api");
    renderPage();
    await waitFor(() => screen.getByText("completed"));
    await user.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() => {
      expect(screen.getByText(/ezpos-backup-demo/)).toBeInTheDocument();
    });
    expect(screen.getByText("customers")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /verify/i }));
    await waitFor(() => {
      expect(verifyBackupApi).toHaveBeenCalledWith(11, expect.anything());
    });
  });
});
