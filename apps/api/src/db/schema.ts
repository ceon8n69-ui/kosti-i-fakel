import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Этап 0: только пользователи и аналитика. Остальные таблицы из ТЗ 12.1 добавляются на своих этапах. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  telegramId: bigint("telegram_id", { mode: "bigint" }).notNull().unique(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  username: text("username"),
  language: text("language").notNull().default("ru"),
  timezone: text("timezone").notNull().default("Europe/Kyiv"),
  authorLevel: integer("author_level").notNull().default(1),
  fame: integer("fame").notNull().default(0),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    payload: jsonb("payload_json").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("analytics_events_name_created_idx").on(t.name, t.createdAt)],
);
