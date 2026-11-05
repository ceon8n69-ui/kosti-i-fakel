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
    /** id подземелья (официального или версии авторского). */
    scenarioId: text("scenario_id").notNull(),
    heroIds: jsonb("hero_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
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

// ───────── Этап 2: герои и золото ─────────

export const heroes = pgTable(
  "heroes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    classId: text("class").notNull(),
    name: text("name").notNull(),
    level: integer("level").notNull().default(1),
    xp: integer("xp").notNull().default(0),
    maxHp: integer("max_hp").notNull(),
    stats: jsonb("stats").$type<Record<string, number>>().notNull(),
    dice: jsonb("dice_json").$type<unknown[]>().notNull(),
    scars: jsonb("scars_json").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    relics: jsonb("relics_json").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    consumables: jsonb("consumables_json").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** alive | in_session | dead */
    status: text("status").notNull().default("alive"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("heroes_user_idx").on(t.userId)],
);

/** Все изменения золота — только через журнал; баланс = сумма delta. */
export const goldLedger = pgTable(
  "gold_ledger",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    transactionId: uuid("transaction_id").notNull(),
    accountType: text("account_type").notNull(),
    accountId: text("account_id").notNull(),
    delta: integer("delta").notNull(),
    reason: text("reason").notNull(),
    sessionId: uuid("session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("gold_ledger_account_idx").on(t.accountType, t.accountId)],
);
