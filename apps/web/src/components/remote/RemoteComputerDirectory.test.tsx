import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RemoteComputerDirectory,
  type RemoteComputer,
} from "./RemoteComputerDirectory";

const device = (
  id: string,
  org: string,
  name: string,
  extra: Partial<RemoteComputer> = {},
): RemoteComputer => ({
  id,
  hostname: `${name}.local`,
  displayName: null,
  organizationId: org,
  organizationName: org === "a" ? "Acme" : "Acme",
  status: "online",
  currentUser: "Ada",
  previousUsers: [],
  transports: { rustdesk: { available: true }, webrtc: { available: true } },
  ...extra,
});
describe("RemoteComputerDirectory", () => {
  afterEach(cleanup);
  it("searches aliases, hostnames and users while separating duplicate organization names", () => {
    render(
      <RemoteComputerDirectory
        devices={[
          device("1", "a", "one", { displayName: "Office" }),
          device("2", "b", "two", { currentUser: "Lin" }),
        ]}
        onBrowser={vi.fn()}
        onDesktop={vi.fn()}
      />,
    );
    expect(screen.getByText("2 computers · 2 organizations")).toBeTruthy();
    expect(screen.getByTestId("remote-group-a")).toBeTruthy();
    expect(screen.getByTestId("remote-group-b")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search computers"), {
      target: { value: "Lin" },
    });
    expect(screen.queryByTestId("remote-device-1")).toBeNull();
    expect(screen.getByTestId("remote-device-2")).toBeTruthy();
  });
  it("restores collapse after clearing search", () => {
    render(
      <RemoteComputerDirectory
        devices={[device("1", "a", "one")]}
        onBrowser={vi.fn()}
        onDesktop={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Collapse Acme/ }));
    fireEvent.change(screen.getByLabelText("Search computers"), {
      target: { value: "one" },
    });
    expect(screen.getByTestId("remote-device-1")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search computers"), {
      target: { value: "" },
    });
    expect(screen.queryByTestId("remote-device-1")).toBeNull();
  });
  it("disables unavailable transport and preserves hostname when clearing alias", async () => {
    const rename = vi.fn().mockResolvedValue(undefined);
    render(
      <RemoteComputerDirectory
        devices={[
          device("1", "a", "one", {
            canRename: true,
            transports: {
              rustdesk: { available: false, reason: "Offline" },
              webrtc: { available: true },
            },
          }),
        ]}
        onBrowser={vi.fn()}
        onDesktop={vi.fn()}
        onRename={rename}
      />,
    );
    expect(screen.getByRole("button", { name: "Desktop app" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Rename one.local" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(rename).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: "one.local" }),
        null,
      ),
    );
  });
  it("keeps the rename dialog open and reports a rejected save", async () => {
    const rename = vi
      .fn()
      .mockRejectedValue(new Error("Server rejected alias"));
    render(
      <RemoteComputerDirectory
        devices={[device("1", "a", "one", { canRename: true })]}
        onBrowser={vi.fn()}
        onDesktop={vi.fn()}
        onRename={rename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename one.local" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Server rejected alias",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  it("disables both launch actions for the busy device", () => {
    render(
      <RemoteComputerDirectory
        devices={[device("1", "a", "one")]}
        busyDeviceId="1"
        onBrowser={vi.fn()}
        onDesktop={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Web Remote" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Desktop app" })).toBeDisabled();
  });
});
