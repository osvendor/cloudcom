/** Queue the worker request before awaiting the gesture-bound side panel open. */
export async function launchWorkspace({ mode, windowId, openSidePanel, send }) {
  if (mode === 'sidepanel' && windowId == null) throw new Error('Browser window is not ready.');
  const pending = Promise.resolve(send());
  const settled = pending.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  try {
    if (mode === 'sidepanel') await openSidePanel({ windowId });
    const result = await settled;
    if (!result.ok) throw result.error;
    return result.value;
  } catch (error) {
    await settled;
    throw error;
  }
}
