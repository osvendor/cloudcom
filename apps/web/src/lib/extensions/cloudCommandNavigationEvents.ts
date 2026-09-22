/** Emitted only by the host API after a successful Cloud Command connection mutation. */
export const CLOUD_COMMAND_CONNECTIONS_CHANGED_EVENT = 'cloudcommand-connections-changed';

export type CloudCommandConnectionsChangedDetail = Readonly<{ organizationId: string }>;

export function dispatchCloudCommandConnectionsChanged(organizationId: string): void {
  window.dispatchEvent(new CustomEvent<CloudCommandConnectionsChangedDetail>(
    CLOUD_COMMAND_CONNECTIONS_CHANGED_EVENT,
    { detail: { organizationId } },
  ));
}
