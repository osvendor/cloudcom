/**
 * A deliberately small, host-owned capability exposed to extension custom
 * elements. The host supplies the implementation; extension code only sees
 * this interface and never receives the user's bearer token.
 */
export interface ExtensionHostApi {
  request(path: string, init?: RequestInit): Promise<Response>;
}
