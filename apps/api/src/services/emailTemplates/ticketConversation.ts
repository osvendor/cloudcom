import { escapeHtml, renderLayout } from '../emailLayout';

interface ConversationTicket {
  id: string;
  internalNumber?: string | null;
  subject: string;
  description?: string | null;
  submitterName?: string | null;
  createdAt?: Date;
}
interface ConversationComment {
  ticketId: string;
  content: string;
  isPublic: boolean;
  deletedAt?: Date | null;
  authorName?: string | null;
  authorType?: string | null;
  createdAt?: Date;
}

export function ticketConversationSubject(ticket: ConversationTicket, brandName: string): string {
  const reference = ticket.internalNumber || ticket.id;
  const match = /^T-\d{4}-(\d+)$/.exec(reference);
  const number = match ? match[1]!.replace(/^0+(?=\d)/, '') : reference;
  return `${brandName} IT SUPPORT TICKET #${number} — ${ticket.subject}`.replace(/[\r\n]+/g, ' ').trim();
}

/** Only public, live entries from this ticket may cross the email boundary. */
export function renderTicketConversation(ticket: ConversationTicket, comments: ConversationComment[], brandName: string): string {
  const text = (value: string) => escapeHtml(value).replace(/\r?\n/g, '<br>');
  const entry = (author: string, content: string, date?: Date) => {
    const timestamp = date ? new Date(date).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '';
    return `<div style="padding:16px 0;border-top:1px solid #d1d5db"><p><strong>${escapeHtml(author)}</strong>${timestamp ? ` · ${escapeHtml(timestamp)}` : ''}</p><div>${text(content)}</div></div>`;
  };
  const history = comments.filter(c => c.ticketId === ticket.id && c.isPublic && !c.deletedAt)
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
    .map(c => entry(c.authorName || (['portal', 'customer', 'email'].includes(c.authorType ?? '') ? 'Customer' : 'Support'), c.content, c.createdAt)).join('');
  const original = ticket.description ? entry(ticket.submitterName || 'Customer', ticket.description, ticket.createdAt) : '';
  const subject = ticketConversationSubject(ticket, brandName);
  return renderLayout({
    title: subject,
    preheader: subject,
    heading: subject,
    body: `<p>Reply to this email to continue the conversation. No login is required.</p><h2 style="font-size:16px">Conversation history</h2>${history}${original}`,
    brandName,
    footer: 'Replies are listed newest first.',
  });
}
