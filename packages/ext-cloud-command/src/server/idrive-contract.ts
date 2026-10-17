import { z } from 'zod';

export const idriveId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const companyId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ids = z.array(idriveId).max(1000);
const numericIds = z.array(companyId).max(1000);
const label = z.string().trim().min(1).max(255);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/);
const emails = z.array(z.email().max(320)).max(25);
const notification = z.enum(['ALWAYS', 'ON_FAILURE', 'NEVER']);
const scheduler = z.object({
  frequency_type: z.enum(['MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'IMMEDIATE']), time,
  start_missed_backup: z.boolean().optional(),
  months: z.array(z.enum(['ALL', 'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'])).max(12).optional(),
  dates: z.array(z.string().regex(/^(?:[1-9]|[12]\d|3[01]|ALL_DAYS|LAST_DAY)$/)).max(32).optional(),
  days: z.array(z.enum(['ALL', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'])).max(7).optional(),
  daily_mode: z.enum(['ALL_DAYS', 'WEEKDAYS']).optional(), cutoff_time: time.optional(),
  email: emails.optional(), send_email_notification: notification.optional(),
}).strict().superRefine((v, ctx) => {
  const missing = v.frequency_type === 'MONTHLY' ? !v.months?.length || !v.dates?.length : v.frequency_type === 'WEEKLY' ? !v.days?.length : v.frequency_type === 'DAILY' ? !v.daily_mode : false;
  if (missing) ctx.addIssue({ code: 'custom', message: 'Complete the selected schedule.' });
});
const backupDetails = z.object({
  what_to_backup: z.enum(['FILE_FOLDER', 'ENTIRE_MACHINE']), where_to_backup: z.enum(['CLOUD', 'LOCAL']),
  items_to_backup: z.array(z.string().min(1).max(4096)).max(500).optional(), local_dest_path: z.string().max(4096).optional(),
}).strict().refine(v => v.what_to_backup !== 'FILE_FOLDER' || !!v.items_to_backup?.length, 'Choose files or folders.');
const planFields = {
  name: label, device_ids: ids.optional(), group_ids: numericIds.optional(), backup_details: backupDetails, scheduler,
  exclude_hidden: z.boolean().optional(), exclude_system: z.boolean().optional(), enable_cdp: z.boolean().optional(),
  cdp_frequency: z.enum(['REAL_TIME', 'TEN_MINUTES', 'THIRTY_MINUTES', 'SIXTY_MINUTES']).optional(),
  exclude_partial: z.string().max(8192).optional(),
};
const planCreate = z.object(planFields).strict();
const planEdit = z.object({ ...planFields, is_enabled: z.boolean().optional() }).partial().strict().refine(v => Object.keys(v).length > 0, 'Choose a change.');
export const idriveAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('company.create'), data: z.object({ name: label }).strict() }).strict(),
  z.object({ kind: z.literal('plan.create'), data: planCreate }).strict(),
  z.object({ kind: z.literal('plan.edit'), id: companyId, data: planEdit }).strict(),
  z.object({ kind: z.literal('group.create'), data: z.object({ name: label, device_ids: ids.optional() }).strict() }).strict(),
  z.object({ kind: z.literal('group.edit'), id: companyId, data: z.object({ name: label.optional(), add_device_ids: ids.optional(), remove_device_ids: ids.optional() }).strict().refine(v => Object.keys(v).length > 0) }).strict(),
  z.object({ kind: z.literal('device.edit'), data: z.object({ device_id: idriveId, custom_tag: z.string().max(255).optional(), metadata: z.record(z.string().min(1).max(128), z.string().max(4096)).refine(v => Object.keys(v).length <= 100).optional() }).strict().refine(v => v.custom_tag !== undefined || v.metadata !== undefined) }).strict(),
  z.object({ kind: z.literal('metadata.delete'), data: z.object({ device_id: idriveId, delete_metadata: z.boolean(), keys_to_delete: z.array(z.string().min(1).max(128)).max(100).optional() }).strict().refine(v => v.delete_metadata || !!v.keys_to_delete?.length) }).strict(),
  z.object({ kind: z.literal('notifications.edit'), data: z.object({ device_id: idriveId, backup_set: z.enum(['DEFAULT', 'LOCAL', 'ENTIRE_MACHINE', 'MAPPED_DRIVE', 'EXPRESS']), type: notification, emails }).strict().refine(v => v.type === 'NEVER' || v.emails.length > 0) }).strict(),
]).superRefine((v, ctx) => {
  if ((v.kind === 'plan.create' || v.kind === 'plan.edit') && v.data.enable_cdp && !v.data.cdp_frequency) ctx.addIssue({ code: 'custom', message: 'Choose a CDP frequency.' });
});
export type IDriveAction = z.infer<typeof idriveAction>;
export type IDriveRow = Record<string, unknown>;
export function record(v: unknown): IDriveRow {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid_provider_response');
  return v as IDriveRow;
}
export function list(v: unknown): IDriveRow[] {
  const values = Array.isArray(v) ? v : [v];
  if (values.length > 10000) throw new Error('provider_result_too_large');
  return values.map(record);
}
export function backupAttention(device: IDriveRow, staleHours: number, now = Date.now()): string | null {
  const state = String(device.backup_status ?? '').toLowerCase();
  if (/fail|error|cancel|not protected/.test(state)) return String(device.backup_status);
  if (!device.last_backup) return 'No successful backup reported';
  const stamp = String(device.last_backup);
  // IDrive samples omit a timezone. Do not silently interpret those as browser local time.
  if (!/(Z|[+-]\d\d:\d\d)$/i.test(stamp)) {
    const assumedUtc = Date.parse(stamp + 'Z');
    if (!Number.isFinite(assumedUtc)) return 'Backup time unavailable';
    // Even the latest plausible UTC offset cannot make a very old report fresh.
    if (now - assumedUtc > (staleHours + 14) * 3600000) return `Backup report older than ${staleHours} hours (timezone unspecified)`;
    return null;
  }
  const age = now - Date.parse(stamp);
  if (!Number.isFinite(age)) return 'Backup time unavailable';
  return age > staleHours * 3600000 ? `No successful backup in ${staleHours} hours` : null;
}
