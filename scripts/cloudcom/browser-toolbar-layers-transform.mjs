// Browser-shell controls sit above the desktop surface. These menus must also
// cover the shell's Disconnect button instead of letting pointer hits reach it.
export function applyBrowserToolbarLayers(name, source) {
  if (name !== 'components/ViewerToolbar.tsx') return source;
  const menu = /<div( role="menu")? className="(absolute [^"]* shadow-xl )z-50([^\"]*)">/g;
  const matches = [...source.matchAll(menu)];
  if (matches.length !== 4) throw new Error('Browser toolbar menu layer attachment points changed');
  return source.replace(menu, '<div$1 data-browser-local-input="true" className="$2z-[10020]$3">');
}
