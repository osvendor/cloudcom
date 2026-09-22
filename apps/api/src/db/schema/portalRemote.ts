import { pgTable, uuid, integer, boolean, text, timestamp, bigint } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';

// Composite tenant/owner/device FKs, checks, indexes and forced RLS are in
// 2026-09-21-portal-remote-access.sql, following the portal schema convention.
export const portalRemoteSettings = pgTable('portal_remote_settings', {
  orgId: uuid('org_id').primaryKey().references(() => organizations.id),
  enabled: boolean('enabled').notNull().default(false),
  webrtcEnabled: boolean('webrtc_enabled').notNull().default(false),
  rustdeskEnabled: boolean('rustdesk_enabled').notNull().default(false),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
export const portalRemoteAssignments = pgTable('portal_remote_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  portalUserId: uuid('portal_user_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  version: integer('version').notNull().default(1),
  enabled: boolean('enabled').notNull().default(true),
  expiresAt: timestamp('expires_at'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
export const portalRemoteSessions = pgTable('portal_remote_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  portalUserId: uuid('portal_user_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  assignmentId: uuid('assignment_id').notNull(),
  assignmentVersion: integer('assignment_version').notNull(),
  authEpoch: integer('auth_epoch').notNull(),
  transport: text('transport').$type<'webrtc' | 'rustdesk'>().notNull(),
  status: text('status').$type<'pending' | 'connecting' | 'active' | 'disconnected' | 'failed' | 'denied'>().notNull().default('pending'),
  webrtcOffer: text('webrtc_offer'),
  webrtcAnswer: text('webrtc_answer'),
  desktopStartCommandId: text('desktop_start_command_id'),
  desktopPromptMode: text('desktop_prompt_mode').$type<'off' | 'notify' | 'consent'>().notNull().default('notify'),
  desktopStartGeneration: bigint('desktop_start_generation', { mode: 'bigint' }).notNull().default(0n),
  terminalGeneration: bigint('terminal_generation', { mode: 'bigint' }),
  terminationPhase: text('termination_phase').$type<'none' | 'pending' | 'confirmed'>().notNull().default('none'),
  hardDeadline: timestamp('hard_deadline').notNull(),
  endedAt: timestamp('ended_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
