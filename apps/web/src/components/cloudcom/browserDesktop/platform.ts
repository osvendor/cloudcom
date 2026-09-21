/** Browser equivalents for the native viewer's window registration/clipboard. */
export async function invoke(command: string, _args?: Record<string, unknown>): Promise<void> {
  if (!['register_session', 'unregister_session', 'register_device', 'update_session_hostname'].includes(command)) {
    throw new Error('This operation requires the native viewer.');
  }
}
export async function readText(): Promise<string> { return navigator.clipboard.readText(); }
export async function writeText(text: string): Promise<void> { await navigator.clipboard.writeText(text); }
