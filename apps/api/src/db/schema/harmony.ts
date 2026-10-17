import { pgTable, uuid, text, varchar, boolean, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { partners } from './orgs';

/** Partner-owned credentials; client inventory lives in the extension's forced-RLS cache. */
export const harmonyIntegrations = pgTable('harmony_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  region: varchar('region', { length: 2 }).notNull(),
  credentialsEncrypted: text('credentials_encrypted').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  version: integer('version').notNull().default(1),
  leaseId: uuid('lease_id'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  lastStatus: varchar('last_status', { length: 16 }).notNull().default('pending'),
  errorCode: varchar('error_code', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  partnerIdx: uniqueIndex('harmony_integrations_partner_idx').on(table.partnerId),
  idPartnerIdx: uniqueIndex('harmony_integrations_id_partner_idx').on(table.id, table.partnerId),
}));
