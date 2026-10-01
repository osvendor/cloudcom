import { describe, expect, it } from 'vitest';
import { renderTicketConversation } from './ticketConversation';

describe('customer ticket conversation', () => {
  it('shows numbered ticket, original request and every public reply newest first, without login', () => {
    const html = renderTicketConversation({ id: 't', internalNumber: 'T-2026-3000', subject: 'Printer', description: 'Original request', submitterName: 'Customer' }, [
      { ticketId: 't', content: 'First public reply', isPublic: true, authorName: 'Alex', createdAt: new Date('2026-09-29T12:00:00Z') },
      { ticketId: 't', content: 'Customer followup', isPublic: true, authorName: 'Customer', createdAt: new Date('2026-09-30T12:00:00Z') },
      { ticketId: 't', content: 'Latest reply', isPublic: true, authorName: 'Alex', createdAt: new Date('2026-09-30T13:00:00Z') },
    ], 'OS');
    expect(html).toContain('OS IT SUPPORT TICKET #3000 — Printer');
    expect(html).toContain('Original request');
    expect(html).toContain('2026-09-30 13:00:00 UTC');
    expect(html.indexOf('Latest reply')).toBeLessThan(html.indexOf('Customer followup'));
    expect(html.indexOf('Customer followup')).toBeLessThan(html.indexOf('First public reply'));
    expect(html).not.toContain('View ticket');
    expect(html).not.toContain('Sign in');
  });
  it('excludes private, deleted and other-ticket entries; escapes all untrusted text', () => {
    const html = renderTicketConversation({ id: 't', subject: '<subject>', description: '<script>original</script>' }, [
      { ticketId: 't', content: 'PRIVATE', isPublic: false },
      { ticketId: 't', content: 'DELETED', isPublic: true, deletedAt: new Date() },
      { ticketId: 'other', content: 'OTHER_TENANT', isPublic: true },
      { ticketId: 't', content: '<img src=x onerror=attack()>\nSecond line', isPublic: true, authorName: '<author>' },
    ], 'OS');
    for (const secret of ['PRIVATE', 'DELETED', 'OTHER_TENANT']) expect(html).not.toContain(secret);
    expect(html).toContain('&lt;author&gt;');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<br>Second line');
    expect(html).not.toContain('<script>');
  });
});
