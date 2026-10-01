import { pgTable, uuid, integer, text, timestamp } from 'drizzle-orm/pg-core';
// Composite target identity and forced RLS are installed in the staff-native migration.
export const staffNativeSessions = pgTable('staff_native_sessions', {
  id: uuid('id').primaryKey().defaultRandom(), orgId: uuid('org_id').notNull(),
  deviceId: uuid('device_id').notNull(), staffUserId: uuid('staff_user_id').notNull(),
  targetId: uuid('target_id').notNull(), targetGeneration: integer('target_generation').notNull(),
  targetPublicKey: text('target_public_key').notNull(), operatorPublicKey: text('operator_public_key').notNull(),
  operatorSessionHash: text('operator_session_hash').notNull(),
  status: text('status').$type<'pending' | 'active' | 'disconnected'>().notNull().default('pending'),
  hardDeadline: timestamp('hard_deadline').notNull(), createdAt: timestamp('created_at').notNull().defaultNow(),
  endedAt: timestamp('ended_at'), ticketHash: text('ticket_hash').notNull(),
  ticketExpiresAt: timestamp('ticket_expires_at').notNull(), consumedAt: timestamp('consumed_at'),
  connectionId: uuid('connection_id'), targetChallenge: text('target_challenge'), channelBinding: text('channel_binding'),
  leaseRevision: integer('lease_revision').notNull().default(0), leaseHash: text('lease_hash'),
  leaseExpiresAt: timestamp('lease_expires_at'), presenceUntil: timestamp('presence_until').notNull(),
});
