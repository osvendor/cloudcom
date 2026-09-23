import type { GoogleTraceItem } from '@cloudcom/ext-cloud-command';

const statuses: Record<number, string> = {
  1: 'Sent', 2: 'Received', 4: 'Flagged as spam', 5: 'Quarantined',
  6: 'Released from quarantine', 7: 'Opened', 10: 'Forwarded',
  11: 'Auto-forwarded', 12: 'Moved to Inbox', 30: 'Bounced',
  34: 'Rate limited', 35: 'Send initiated',
};
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const bounded = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
function parameters(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!Array.isArray(value)) return result;
  for (const entry of value.slice(0, 50)) {
    const item = record(entry);
    if (!item || typeof item.name !== 'string' || !/^[A-Za-z_]{1,80}$/.test(item.name)) continue;
    const nested = record(item.messageValue);
    const multi = Array.isArray(item.multiMessageValue) ? item.multiMessageValue.slice(0, 10)
      .map(entry => parameters(record(entry)?.parameter)) : null;
    result[item.name] = nested ? parameters(nested.parameter) : multi ?? item.value ?? item.intValue ?? item.boolValue
      ?? item.multiValue ?? item.multiIntValue ?? null;
  }
  return result;
}
export function projectGoogleTrace(items: unknown, customerId: string, startMs: number, endMs: number) {
  const rows: GoogleTraceItem[] = [];
  let partial = false;
  if (!Array.isArray(items)) return { rows, partial: true };
  for (const raw of items.slice(0, 100)) {
    const item = record(raw);
    const id = record(item?.id);
    const at = id?.time;
    const qualifier = id?.uniqueQualifier;
    if (id?.customerId !== customerId || id?.applicationName !== 'gmail'
      || typeof at !== 'string' || !Number.isFinite(Date.parse(at))
      || Date.parse(at) < startMs || Date.parse(at) > endMs
      || typeof qualifier !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(qualifier)) {
      partial = true; continue;
    }
    if (!Array.isArray(item?.events) || item.events.length === 0) { partial = true; continue; }
    for (const [index, rawEvent] of item.events.slice(0, 10).entries()) {
      const event = record(rawEvent);
      const values = parameters(event?.parameters);
      const message = record(values.message_info);
      const info = record(values.event_info);
      const source = record(message?.source);
      const destination = record(message?.destination);
      const code = Number(info?.mail_event_type);
      const recipient = Array.isArray(message?.flattened_destinations)
        ? message.flattened_destinations.filter((x): x is string => typeof x === 'string').slice(0, 10).join(', ')
        : message?.flattened_destinations;
      rows.push({ id: `${qualifier}-${index}`, at: new Date(at).toISOString(),
        sender: bounded(source?.address ?? source?.from_header_address, 320),
        recipient: bounded(recipient ?? destination?.address, 1000),
        subject: bounded(message?.subject, 500),
        status: Number.isSafeInteger(code) && statuses[code] ? statuses[code] : 'Other mail event',
        messageId: bounded(message?.rfc2822_message_id, 500),
        description: bounded(message?.description, 1000) });
    }
    if (item.events.length > 10) partial = true;
  }
  if (items.length > 100) partial = true;
  return { rows, partial };
}
