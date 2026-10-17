import type { ExtensionRequestAuthorization } from '@breeze/extension-sdk';
import type { HarmonyComputer, HarmonyGroup, HarmonyRegion } from './harmony-contract';

export type HarmonyRequest = { auth: unknown; authorization: ExtensionRequestAuthorization; orgId: string };
export type HarmonyScope = { kind: 'group' | 'endpoint'; externalId: string };
export type HarmonyConnectionInput = { version: number | null; region: HarmonyRegion; enabled: boolean; clientId?: string; accessKey?: string };
export type HarmonyConnectionStatus = {
  available: boolean; connected: boolean; enabled: boolean; canConfigure: boolean;
  version: number | null; region: HarmonyRegion | null; checkedAt: string | null;
  status: 'not_connected' | 'not_mapped' | 'pending' | 'ready' | 'failed' | 'disabled';
  errorCode: string | null; mappings: HarmonyScope[];
};
export type HarmonyCachedComputer = HarmonyComputer & { deviceId: string | null };
export type HarmonyClientInventory = {
  computers: HarmonyCachedComputer[]; checkedAt: string | null; stale: boolean;
  devices: { id: string; name: string }[];
};
/** The host owns credentials, authorization, short transactions and cache publication. */
export interface NativeHarmonyServices {
  version: 1;
  /** Host scheduler only; never exposed as a request route. */
  refreshDue(): Promise<void>;
  connection(request: HarmonyRequest): Promise<HarmonyConnectionStatus>;
  configure(request: HarmonyRequest, input: HarmonyConnectionInput): Promise<HarmonyConnectionStatus>;
  discover(request: HarmonyRequest): Promise<{ version: number; groups: HarmonyGroup[]; computers: Pick<HarmonyComputer, 'id' | 'name'>[] }>;
  map(request: HarmonyRequest, input: { version: number; mappings: HarmonyScope[] }): Promise<HarmonyConnectionStatus>;
  sync(request: HarmonyRequest): Promise<{ checkedAt: string; count: number; conflictedEndpointCount: number; unavailableScopeCount: number }>;
  inventory(request: HarmonyRequest): Promise<HarmonyClientInventory>;
  link(request: HarmonyRequest, input: { externalId: string; deviceId: string | null; checkedAt: string }): Promise<{ success: true }>;
}
