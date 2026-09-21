import { fetchWithAuth } from '@/stores/auth';

/** A raced HTTP End is successful only after provider-confirmed termination. */
export async function endBrowserSession(sessionId: string): Promise<void> {
  const path = `/remote/sessions/${encodeURIComponent(sessionId)}`;
  const ended = await fetchWithAuth(`${path}/end`, { method: 'POST' });
  if (!ended.ok && ended.status !== 400) throw new Error('Unable to end the remote session. Retry disconnect.');
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetchWithAuth(path);
    if (!response.ok) throw new Error('Unable to confirm session termination. Retry disconnect.');
    const session = await response.json();
    if (['disconnected', 'failed', 'denied'].includes(session.status) && session.terminationPhase === 'confirmed') return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('The device has not confirmed disconnect yet. Retry before starting another session.');
}
