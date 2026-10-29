/** Prepare the browser binding before a full-page identity-provider handoff. */
export async function bootstrapThenNavigate(
  url: string,
  navigate: (url: string) => void = target => window.location.assign(target),
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${import.meta.env.PUBLIC_API_URL || ''}/api/v1/auth/browser-binding/bootstrap`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Authentication bootstrap failed');
    navigate(url);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Sign-in preparation timed out. Please wait a moment and retry.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
