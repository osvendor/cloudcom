export class ThreeCxReadError extends Error { code: string; constructor(code: string); }
export function normalizePbxOrigin(value: string): string;
export interface ReadScope { organizationId: string; partnerId: string; actorId: string }
export interface ReadConnection {
  id: string; organizationId: string; partnerId: string; origin: string; enabled: boolean;
  departmentId?: number | null; credentialRef?: unknown;
}
export function publicConnection(connection: ReadConnection): Record<string, unknown>;
export function createThreeCxReadService(ports: {
  authorize(scope: ReadScope, action: string): Promise<boolean>;
  loadConnection(scope: ReadScope, id: string): Promise<ReadConnection | null | undefined>;
  readUsers(input: { scope: ReadScope; connectionId: string; origin: string; credentialRef?: unknown; query: Record<string, string | number> }): Promise<unknown>;
}): { listExtensions(scope: ReadScope, id: string, skip?: number): Promise<{ items: Record<string, unknown>[]; nextSkip: number | null; truncated: boolean }> };
