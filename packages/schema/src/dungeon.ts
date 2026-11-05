import { z } from "zod";

/**
 * DungeonDefinition v1 (ТЗ 12.2). Один формат для официальных и авторских подземелий.
 *
 * Плитки — строки одинаковой длины:
 *   '#' стена, '.' пол, '~' вода (проходима, ход стоит вдвое), '_' пропасть (непроходима), ' ' пусто.
 * Комнаты не хранятся: это связные области пола между стенами и дверями (заливкой).
 */
const int = z.number().int();
const cell = { x: int.min(0).max(31), y: int.min(0).max(31) };
const id = z.string().regex(/^[a-z0-9_]{1,32}$/);
const textId = z.string().min(1).max(40);
const attr = z.enum(["STR", "DEX", "INT", "SPI"]);
const dc = int.min(8).max(20);

export const TILE_CHARS = "#.~_ ";

export const LootSchema = z.object({
  gold: int.min(0).max(1000).default(0),
  /** Предметы из каталога (items.json): расходники, реликвии, грани. */
  items: z.array(z.string()).max(4).default([]),
});

const base = { id, ...cell };

export const DungeonObjectSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("entrance") }),
  z.object({ ...base, type: z.literal("treasury"), textId: textId.optional() }),
  z.object({
    ...base,
    type: z.literal("door"),
    /** Запертая: ключ или взлом (проверка СИЛ). */
    lock: z.object({ keyId: id.optional(), dc: dc.optional() }).optional(),
    /** Секретная: не видна, пока не найдена осмотром (РАЗ). */
    secretDc: dc.optional(),
    open: z.boolean().default(false),
  }),
  z.object({ ...base, type: z.literal("chest"), loot: LootSchema, lock: z.object({ keyId: id.optional(), dc: dc.optional() }).optional() }),
  z.object({ ...base, type: z.literal("lever"), variable: id, textId: textId.optional() }),
  z.object({ ...base, type: z.literal("plate"), variable: id }),
  z.object({
    ...base,
    type: z.literal("altar"),
    textId,
    /** Вариант автора: проверка и что даёт успех. */
    check: z.object({ attr, dc, successTextId: textId, failTextId: textId, variable: id.optional(), loot: LootSchema.optional() }).optional(),
  }),
  z.object({ ...base, type: z.literal("campfire") }),
  z.object({ ...base, type: z.literal("light"), radius: int.min(1).max(4).default(2) }),
  z.object({ ...base, type: z.literal("note"), textId }),
  z.object({ ...base, type: z.literal("npc"), npcId: id }),
  z.object({ ...base, type: z.literal("key"), keyId: id, textId: textId.optional() }),
  z.object({ ...base, type: z.literal("trap"), trapId: z.string(), hidden: z.boolean().default(true) }),
]);
export type DungeonObject = z.infer<typeof DungeonObjectSchema>;
export type DungeonObjectType = DungeonObject["type"];

/** Столкновение: начинается, когда отряд входит в зону. */
export const EncounterSchema = z.object({
  id,
  zone: z.object({ ...cell, w: int.min(1).max(32), h: int.min(1).max(32) }),
  monsters: z.array(z.string()).min(1).max(8),
  /** Текст перед боем. */
  textId: textId.optional(),
  /** Босс: победа над ним открывает сокровищницу (если так задано правилами). */
  boss: z.boolean().default(false),
});
export type Encounter = z.infer<typeof EncounterSchema>;

export const NpcSchema = z.object({
  id,
  name: z.string().min(1).max(32),
  character: z.string().max(300),
  goal: z.string().max(200).default(""),
  secret: z.string().max(200).default(""),
  /** Автоматический режим: реплики автора. */
  lines: z.array(textId).min(1).max(6),
  outcomes: z
    .array(z.enum(["give_item", "open_door", "attack", "hint", "refuse"]))
    .min(1)
    .default(["hint"]),
  /** Для give_item / open_door. */
  itemId: z.string().optional(),
  doorId: id.optional(),
});
export type NpcDefinition = z.infer<typeof NpcSchema>;

export const VariableSchema = z.object({ id, initial: int.min(-99).max(99).default(0) });
export type VariableDefinition = z.infer<typeof VariableSchema>;

const zone = z.object({ ...cell, w: int.min(1).max(32), h: int.min(1).max(32) });

export const RuleEventSchema = z.discriminatedUnion("on", [
  z.object({ on: z.literal("enter_zone"), zone }),
  z.object({ on: z.literal("use_object"), objectId: id }),
  z.object({ on: z.literal("monster_died"), encounterId: id }),
  z.object({ on: z.literal("item_taken"), objectId: id }),
  z.object({ on: z.literal("light_below"), value: int.min(0).max(60) }),
  z.object({ on: z.literal("round_start"), round: int.min(1).max(20) }),
]);

export const RuleConditionSchema = z.discriminatedUnion("if", [
  z.object({ if: z.literal("has_item"), keyId: id }),
  z.object({ if: z.literal("variable"), variable: id, op: z.enum(["eq", "gte", "lte"]), value: int }),
  z.object({ if: z.literal("class_in_party"), classId: z.string() }),
  z.object({ if: z.literal("party_size"), op: z.enum(["eq", "gte", "lte"]), value: int.min(1).max(4) }),
  z.object({ if: z.literal("light"), op: z.enum(["gte", "lte"]), value: int.min(0).max(60) }),
]);

export const RuleActionSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("open_door"), doorId: id }),
  z.object({ do: z.literal("close_door"), doorId: id }),
  z.object({ do: z.literal("arm_trap"), trapId: id }),
  z.object({ do: z.literal("spawn"), monsters: z.array(z.string()).min(1).max(4) }),
  z.object({ do: z.literal("show_text"), textId }),
  z.object({ do: z.literal("change_light"), delta: int.min(-20).max(20) }),
  z.object({ do: z.literal("set_variable"), variable: id, value: int }),
  z.object({ do: z.literal("flood_zone"), zone }),
  z.object({ do: z.literal("set_tile"), ...cell, tile: z.enum(["#", ".", "~", "_"]) }),
]);

export const DungeonRuleSchema = z.object({
  id,
  event: RuleEventSchema,
  conditions: z.array(RuleConditionSchema).max(4).default([]),
  actions: z.array(RuleActionSchema).min(1).max(8),
  /** Сколько раз правило может сработать (по умолчанию из balance.builder). */
  limit: int.min(1).max(99).optional(),
});
export type DungeonRule = z.infer<typeof DungeonRuleSchema>;

export const DungeonDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    title: z.string().min(1).max(48),
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    /** Обучающее: без постоянной смерти, награды от системы. */
    tutorial: z.boolean().default(false),
    size: z.object({ w: int.min(4).max(32), h: int.min(4).max(32) }),
    tiles: z.array(z.string()),
    objects: z.array(DungeonObjectSchema).max(200),
    encounters: z.array(EncounterSchema).max(30),
    npcs: z.array(NpcSchema).max(8).default([]),
    rules: z.array(DungeonRuleSchema).max(30).default([]),
    variables: z.array(VariableSchema).max(16).default([]),
    /** Тексты автора; ключ intro показывается при входе. */
    texts: z.record(textId, z.string().max(400)),
  })
  .superRefine((d, ctx) => {
    if (d.tiles.length !== d.size.h) ctx.addIssue({ code: "custom", message: "tiles: rows != size.h" });
    d.tiles.forEach((row, y) => {
      if (row.length !== d.size.w) ctx.addIssue({ code: "custom", message: `tiles[${y}]: length != size.w` });
      if ([...row].some((c) => !TILE_CHARS.includes(c))) ctx.addIssue({ code: "custom", message: `tiles[${y}]: bad char` });
    });
    const ids = new Set<string>();
    for (const o of d.objects) {
      if (ids.has(o.id)) ctx.addIssue({ code: "custom", message: `duplicate object id ${o.id}` });
      ids.add(o.id);
      if (o.x >= d.size.w || o.y >= d.size.h) ctx.addIssue({ code: "custom", message: `${o.id}: out of map` });
      else if (!".~".includes(d.tiles[o.y]![o.x]!)) ctx.addIssue({ code: "custom", message: `${o.id}: not on floor` });
    }
    const count = (t: string) => d.objects.filter((o) => o.type === t).length;
    if (count("entrance") !== 1) ctx.addIssue({ code: "custom", message: "exactly one entrance required" });
    if (count("treasury") !== 1) ctx.addIssue({ code: "custom", message: "exactly one treasury required" });
    if (count("campfire") > 2) ctx.addIssue({ code: "custom", message: "at most two campfires" });
    const textKeys = new Set(Object.keys(d.texts));
    const refs: string[] = [];
    for (const o of d.objects) if ("textId" in o && o.textId) refs.push(o.textId);
    for (const e of d.encounters) if (e.textId) refs.push(e.textId);
    for (const n of d.npcs) refs.push(...n.lines);
    for (const r of d.rules) for (const a of r.actions) if (a.do === "show_text") refs.push(a.textId);
    for (const t of refs) if (!textKeys.has(t)) ctx.addIssue({ code: "custom", message: `missing text ${t}` });
  });
export type DungeonDefinition = z.infer<typeof DungeonDefinitionSchema>;
