import { describe, expect, it, vi } from 'vitest';
import { listRemoteAccessOptions, launchRemoteAccessOption } from './remoteAccessOptions';
import { decryptForColumn } from '../secretCrypto';

vi.mock('../secretCrypto', () => ({ decryptForColumn: vi.fn((_table, _column, value) => value) }));
const rustdesk = { id: 'rustdesk', name: 'RustDesk', enabled: true, customFieldKey: 'rustdesk_id', urlTemplate: 'rustdesk://{id}', password: 'private' };
const other = { ...rustdesk, id: 'other', name: 'Other', urlTemplate: 'https://remote.example.com/{id}' };
const device = { customFields: { rustdesk_id: '12&34' } };

describe('explicit remote access options', () => {
  it('lists enabled providers without exposing or decrypting secrets', () => {
    vi.mocked(decryptForColumn).mockClear();
    expect(listRemoteAccessOptions(device, { providers: [rustdesk, { ...other, enabled: false }] })).toEqual([
      { id: 'rustdesk', name: 'RustDesk', available: true, skipReason: null },
    ]);
    expect(decryptForColumn).not.toHaveBeenCalled();
  });
  it('reports missing device identifiers without returning settings', () => {
    expect(listRemoteAccessOptions({}, { providers: [rustdesk] })[0]).toEqual({
      id: 'rustdesk', name: 'RustDesk', available: false, skipReason: 'missing_device_identifier',
    });
    expect(listRemoteAccessOptions(device, undefined)).toEqual([]);
  });
  it('selects a nondefault tool and preserves the original settings', () => {
    const settings = { defaultProviderId: 'other', providers: [rustdesk, other] };
    expect(launchRemoteAccessOption(device, settings, 'rustdesk').launchUrl).toBe('rustdesk://12%2634');
    expect(settings.defaultProviderId).toBe('other');
  });
  it.each(['unknown', 'disabled'])('never falls back from %s to an enabled default', id => {
    const settings = { defaultProviderId: 'other', providers: [other, { ...rustdesk, id: 'disabled', enabled: false }] };
    expect(launchRemoteAccessOption(device, settings, id).launchUrl).toBeNull();
  });
  it('retains upstream scheme validation at issuance', () => {
    const settings = { providers: [{ ...rustdesk, urlTemplate: 'javascript:alert(1)' }] };
    expect(launchRemoteAccessOption(device, settings, 'rustdesk').skipReason).toBe('scheme_not_allowed');
  });
});
