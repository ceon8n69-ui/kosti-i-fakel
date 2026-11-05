import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

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

// ───────── Этап 1: партии и журнал событий ─────────

/** Партия (поход). seed раскрывается только после окончания; до этого виден seed_hash. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tableId: uuid("table_id"),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    scenarioId: text("scenario_id").notNull(),
    seedHash: text("seed_hash").notNull(),
    seed: text("seed").notNull(),
    seq: integer("seq").notNull(),
    state: text("state").notNull().default("active"),
    endedReason: text("ended_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("sessions_owner_state_idx").on(t.ownerId, t.state)],
);

export const sessionEvents = pgTable(
  "session_events",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
    actorId: uuid("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

export const sessionSnapshots = pgTable(
  "session_snapshots",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    state: jsonb("state_json").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

/** Обработанные команды: повтор того же commandId возвращает прежний результат. */
export const sessionCommands = pgTable(
  "session_commands",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    commandId: text("command_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    type: text("type").notNull(),
    firstSeq: integer("first_seq").notNull(),
    lastSeq: integer("last_seq").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.commandId] })],
);
