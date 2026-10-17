import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import DesktopViewer from './upstream/components/DesktopViewer';

describe('generated browser desktop initial render', () => {
  it('renders the real viewer before any transport or clipboard effects run', () => {
    const markup = renderToString(<DesktopViewer
      params={{ mode: 'desktop', apiUrl: 'https://breeze.example.com', sessionId: 'test-session', connectCode: 'private-connect-code', deviceId: 'test-device' }}
      closing={false}
      onDisconnect={() => {}}
      onError={() => {}}
    />);
    expect(markup).toContain('Connecting');
    expect(markup).not.toContain('private-connect-code');
  });
});
