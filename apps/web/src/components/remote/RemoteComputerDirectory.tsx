import { useMemo, useState } from "react";

export type RemoteComputer = {
  id: string;
  hostname: string;
  displayName: string | null;
  organizationId: string;
  organizationName: string;
  status: string;
  currentUser: string | null;
  previousUsers: string[];
  canRename?: boolean;
  transports: {
    rustdesk: { available: boolean; reason?: string };
    webrtc: { available: boolean; reason?: string };
  };
};
export type RemoteComputerDirectoryProps = {
  devices: RemoteComputer[];
  busyDeviceId?: string | null;
  onBrowser: (device: RemoteComputer) => void;
  onDesktop: (device: RemoteComputer) => void;
  onRename?: (device: RemoteComputer, name: string | null) => Promise<void>;
};

export function RemoteComputerDirectory({
  devices,
  busyDeviceId,
  onBrowser,
  onDesktop,
  onRename,
}: RemoteComputerDirectoryProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [renameDevice, setRenameDevice] = useState<RemoteComputer | null>(null);
  const [alias, setAlias] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const normalized = query.trim().toLowerCase();
  const searching = Boolean(normalized);
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { id: string; name: string; devices: RemoteComputer[] }
    >();
    devices.forEach((device) => {
      const values = [
        device.organizationName,
        device.hostname,
        device.displayName ?? "",
        device.currentUser ?? "",
        ...device.previousUsers,
      ];
      if (
        searching &&
        !values.some((value) => value.toLowerCase().includes(normalized))
      )
        return;
      const group = map.get(device.organizationId) ?? {
        id: device.organizationId,
        name: device.organizationName,
        devices: [],
      };
      group.devices.push(device);
      group.devices.sort((left, right) => {
        const leftName = left.displayName?.trim() || left.hostname;
        const rightName = right.displayName?.trim() || right.hostname;
        return (
          leftName.localeCompare(rightName) ||
          left.hostname.localeCompare(right.hostname)
        );
      });
      map.set(device.organizationId, group);
    });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [devices, normalized, searching]);
  const openRename = (device: RemoteComputer) => {
    setRenameDevice(device);
    setAlias(device.displayName ?? "");
    setRenameError(null);
  };
  const saveRename = async () => {
    if (!renameDevice || !onRename || renameSaving) return;
    setRenameSaving(true);
    setRenameError(null);
    try {
      await onRename(renameDevice, alias.trim() || null);
      setRenameDevice(null);
    } catch (error) {
      setRenameError(
        error instanceof Error ? error.message : "Unable to rename computer.",
      );
    } finally {
      setRenameSaving(false);
    }
  };
  return (
    <section className="space-y-3" aria-label="Remote computers">
      <div className="flex items-center gap-3">
        <label className="sr-only" htmlFor="remote-computer-search">
          Search computers
        </label>
        <input
          id="remote-computer-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search computers"
          className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
        />
        <span className="text-xs text-muted-foreground">
          {groups.reduce((count, group) => count + group.devices.length, 0)}{" "}
          computers · {groups.length} organizations
        </span>
      </div>
      <div className="overflow-hidden rounded-md border bg-card">
        {groups.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            No computers found.
          </p>
        ) : (
          groups.map((group) => {
            const isCollapsed = !searching && collapsed[group.id];
            return (
              <div
                key={group.id}
                data-testid={`remote-group-${group.id}`}
                className="border-b last:border-b-0"
              >
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium hover:bg-muted/40"
                  aria-expanded={!isCollapsed}
                  aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.name}`}
                  onClick={() =>
                    setCollapsed((value) => ({
                      ...value,
                      [group.id]: !value[group.id],
                    }))
                  }
                >
                  <span>{group.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {group.devices.length}{" "}
                    <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
                  </span>
                </button>
                {!isCollapsed && (
                  <ul className="divide-y">
                    {group.devices.map((device) => {
                      const title =
                        device.displayName?.trim() || device.hostname;
                      const online = device.status.toLowerCase() === "online";
                      return (
                        <li
                          key={device.id}
                          data-testid={`remote-device-${device.id}`}
                          className="flex items-center gap-3 px-3 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">
                              {title}
                            </div>
                            {device.displayName && (
                              <div className="truncate text-xs text-muted-foreground">
                                {device.hostname}
                              </div>
                            )}
                            <div className="flex items-center gap-1 text-xs">
                              <span
                                className={`inline-block h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-muted-foreground"}`}
                                aria-hidden="true"
                              />
                              <span>{online ? "Online" : "Offline"}</span>
                              <span className="sr-only">
                                Computer status: {device.status}
                              </span>
                            </div>
                            <div className="text-xs">
                              {device.currentUser ? (
                                <>
                                  <span className="text-muted-foreground">
                                    Current user:{" "}
                                  </span>
                                  <span className="font-medium">
                                    {device.currentUser}
                                  </span>
                                </>
                              ) : device.previousUsers[0] ? (
                                <>
                                  <span className="text-muted-foreground">
                                    Last user:{" "}
                                  </span>
                                  {device.previousUsers[0]}
                                </>
                              ) : (
                                <span className="text-muted-foreground">
                                  No user recorded
                                </span>
                              )}
                              {device.previousUsers
                                .slice(device.currentUser ? 0 : 1)
                                .map((user) => (
                                  <span
                                    key={user}
                                    className="ml-2 text-muted-foreground"
                                  >
                                    Previous: {user}
                                  </span>
                                ))}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              onClick={() => onBrowser(device)}
                              disabled={
                                !device.transports.webrtc.available ||
                                busyDeviceId === device.id
                              }
                              title={
                                device.transports.webrtc.available
                                   ? "Open Web Remote"
                                  : (device.transports.webrtc.reason ??
                                     "Web Remote unavailable")
                              }
                              className="rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Web Remote
                            </button>
                            <button
                              type="button"
                              onClick={() => onDesktop(device)}
                              disabled={
                                !device.transports.rustdesk.available ||
                                busyDeviceId === device.id
                              }
                              title={
                                device.transports.rustdesk.available
                                  ? "Open desktop app"
                                  : (device.transports.rustdesk.reason ??
                                    "Desktop unavailable")
                              }
                              className="rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Desktop app
                            </button>
                            {device.canRename && onRename && (
                              <button
                                type="button"
                                aria-label={`Rename ${title}`}
                                onClick={() => openRename(device)}
                                className="rounded border px-2 py-1 text-xs"
                              >
                                Rename
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </div>
      {renameDevice && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="rename-computer-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-5 shadow-lg">
            <h2 id="rename-computer-title" className="text-lg font-semibold">
              Rename computer
            </h2>
            <p className="text-sm text-muted-foreground">
              Original computer name:{" "}
              <span className="font-medium text-foreground">
                {renameDevice.hostname}
              </span>
            </p>
            {renameError && (
              <p role="alert" className="text-sm text-destructive">
                {renameError}
              </p>
            )}
            <label className="block text-sm">
              Alias
              <input
                autoFocus
                maxLength={255}
                value={alias}
                onChange={(event) => setAlias(event.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={renameSaving}
                onClick={() => setRenameDevice(null)}
                className="rounded border px-3 py-2 text-sm disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={renameSaving}
                onClick={() => void saveRename()}
                className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
              >
                {renameSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
