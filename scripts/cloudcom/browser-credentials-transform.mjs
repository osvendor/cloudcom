// Kept outside generated sources so upstream viewer refreshes preserve the vault slot.
function replaceOnce(source, marker, replacement) {
  if (source.split(marker).length !== 2) throw new Error(`Credential toolbar attachment point changed: ${marker}`);
  return source.replace(marker, replacement);
}
export function applyCredentialToolbar(name, source) {
  if (name === 'components/DesktopViewer.tsx') {
    return replaceOnce(source, '<ViewerToolbar\n', '<ViewerToolbar\n        credentialSessionId={params.mode === \'desktop\' ? params.sessionId : undefined}\n        credentialsEnabled={!closing && status === \'connected\'}\n');
  }
  if (name !== 'components/ViewerToolbar.tsx') return source;
  source = "import SessionCredentials from '../../SessionCredentials';\n" + source;
  source = replaceOnce(source, 'interface Props {', 'interface Props {\n  credentialSessionId?: string;\n  credentialsEnabled?: boolean;');
  source = replaceOnce(source, 'export default function ViewerToolbar({', 'export default function ViewerToolbar({\n  credentialSessionId, credentialsEnabled = false,');
  return replaceOnce(source, '{/* Paste as Keystrokes */}', '<SessionCredentials sessionId={credentialSessionId} enabled={credentialsEnabled} />\n      {/* Paste as Keystrokes */}');
}
