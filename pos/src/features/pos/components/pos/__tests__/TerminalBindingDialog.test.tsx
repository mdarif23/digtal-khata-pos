import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/auth/sessionStore";

// The Bangladesh-typical shop is ONE PC: when nothing is registered yet and
// the user can manage terminals, the boot dialog must offer ONE-CLICK setup
// (create terminal + bind) instead of hiding and forcing a Settings visit.
// Cashiers without permission keep the old invisible-unless-required
// behavior, and businesses with terminals keep the "This is 'X'" list.

vi.mock("../../../../../api/axios.js", () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getBoundTerminalId: vi.fn(() => null),
  bindThisTerminal: vi.fn(),
}));

import axios, { bindThisTerminal } from "../../../../../api/axios.js";
import { TerminalBindingDialog } from "../TerminalBindingDialog.js";

const mockedGet = vi.mocked(axios.get);
const mockedPost = vi.mocked(axios.post);
const mockedBind = vi.mocked(bindThisTerminal);

function loginAs(permissions: string[]) {
  useSessionStore.getState().setSession({
    user: { id: 1, fullName: "Owner", email: "o@example.test" },
    businessId: 1,
    businessMode: null,
    roleSlug: "owner",
    roleName: "Owner",
    roles: [],
    permissions,
  });
  useSessionStore.setState({ activeLocationName: "Main Store" });
}

function emptyTerminalsResponse() {
  return { data: { success: true, data: [] } };
}

describe("TerminalBindingDialog — one-click self setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockImplementation(((url: string) => {
      if (url === "/terminals") {
        return Promise.resolve(emptyTerminalsResponse());
      }
      if (url === "/pos-settings") {
        return Promise.resolve({ data: { data: { requireTerminal: false } } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    }) as unknown as typeof axios.get);
  });

  it("offers one-click setup for a manager when no terminals exist", async () => {
    loginAs(["pos_terminal.manage"]);
    mockedPost.mockResolvedValueOnce({
      data: { success: true, data: { id: 5, name: "Main Store" } },
    });
    const user = userEvent.setup();
    render(<TerminalBindingDialog />);

    expect(
      await screen.findByText("Set up this PC as your sales terminal?"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Yes, set up this PC/ }));

    // Terminal created from the active location's name...
    await waitFor(() =>
      expect(mockedPost).toHaveBeenCalledWith("/terminals", { name: "Main Store" }),
    );
    // ...and the PC bound immediately (persist + reload inside).
    await waitFor(() => expect(mockedBind).toHaveBeenCalledWith(5));
  });

  it("stays hidden for users who cannot manage when binding is optional", async () => {
    loginAs(["pos.create_sale"]);
    const { container } = render(<TerminalBindingDialog />);
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the 'This is …' list when terminals already exist", async () => {
    loginAs([]);
    mockedGet.mockImplementation(((url: string) => {
      if (url === "/terminals") {
        return Promise.resolve({
          data: {
            success: true,
            data: [
              { id: 5, name: "Counter 1", status: "active" },
              { id: 6, name: "Counter 2", status: "inactive" },
            ],
          },
        });
      }
      if (url === "/pos-settings") {
        return Promise.resolve({ data: { data: { requireTerminal: false } } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    }) as unknown as typeof axios.get);

    const user = userEvent.setup();
    render(<TerminalBindingDialog />);

    // Only ACTIVE terminals are offered.
    expect(
      await screen.findByRole("button", { name: /This is “Counter 1”/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Counter 2/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /This is “Counter 1”/ }));
    await waitFor(() => expect(mockedBind).toHaveBeenCalledWith(5));
  });
});
