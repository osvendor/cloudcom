import { pgTable, uuid, integer, boolean, text, timestamp } from 'drizzle-orm/pg-core';
// Composite identity constraints and forced RLS are installed by the native admission migration.
export const portalNativeTargets = pgTable('portal_native_targets', {
  id: uuid('id').primaryKey().defaultRandom(), orgId: uuid('org_id').notNull(), deviceId: uuid('device_id').notNull(),
  installationId: uuid('installation_id').notNull(), rustdeskId: text('rustdesk_id').notNull(), publicKey: text('public_key').notNull(),
  generation: integer('generation').notNull().default(1), credentialHash: text('credential_hash').notNull(),
  enabled: boolean('enabled').notNull().default(true), createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
export const portalNativeAdmissions = pgTable('portal_native_admissions', {
  sessionId: uuid('session_id').primaryKey(), orgId: uuid('org_id').notNull(), deviceId: uuid('device_id').notNull(),
  portalUserId: uuid('portal_user_id').notNull(), targetId: uuid('target_id').notNull(),
  targetGeneration: integer('target_generation').notNull(), targetPublicKey: text('target_public_key').notNull(),
  operatorPublicKey: text('operator_public_key').notNull(), ticketHash: text('ticket_hash').notNull(),
  ticketExpiresAt: timestamp('ticket_expires_at').notNull(), consumedAt: timestamp('consumed_at'),
  connectionId: uuid('connection_id'), targetChallenge: text('target_challenge'), channelBinding: text('channel_binding'),
  leaseRevision: integer('lease_revision').notNull().default(0), leaseHash: text('lease_hash'), leaseExpiresAt: timestamp('lease_expires_at'),
  presenceUntil: timestamp('presence_until').notNull(), operatorSessionHash: text('operator_session_hash').notNull(),
});
