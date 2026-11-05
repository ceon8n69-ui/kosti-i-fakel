import { z } from "zod";

const int = z.number().int();
const attr = z.enum(["STR", "DEX", "INT", "SPI"]);

/**
 * Грань кубика героя. t: M ближний, L дальний, I магия, B блок (Щ), H лечение (С),
 * STAR звезда, SKULL череп. Свойства: taunt — Провокация, poison — Яд(n), all — по всем врагам.
 */
export const FaceSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.enum(["M", "L", "I", "B", "H"]),
    n: int.min(0).max(20),
    taunt: z.boolean().optional(),
    poison: int.min(1).max(10).optional(),
    all: z.boolean().optional(),
  }),
  z.object({ t: z.literal("STAR") }),
  z.object({ t: z.literal("SKULL") }),
]);
export type Face = z.infer<typeof FaceSchema>;

const DieSchema = z.array(FaceSchema).length(6);

export const ClassSchema = z.object({
  id: z.string(),
  hp: int.positive(),
  stats: z.record(attr, int.min(-1).max(4)),
  dice: z.tuple([DieSchema, DieSchema, DieSchema]),
});

export const MonsterSchema = z.object({
  id: z.string(),
  cost: int.nonnegative(),
  hp: int.positive(),
  armor: int.nonnegative(),
  row: z.enum(["front", "back"]),
  boss: z.boolean().default(false),
  behavior: z.string(),
  params: z.record(z.string(), z.number()).default({}),
  /** Кого зовёт босс (boss_summon). */
  spawn: z.string().optional(),
});

export const TrapSchema = z.object({
  id: z.string(),
  cost: int.nonnegative(),
  spot: attr,
  disarm: attr,
  dc: int.min(1).max(30),
  effect: z.string(),
  params: z.record(z.string(), z.number()).default({}),
});

export const BalanceSchema = z.object({
  version: int.positive(),
  checks: z.object({
    dc: z.object({ easy: int, normal: int, hard: int, nearlyImpossible: int }),
    freeActionDc: z.object({ min: int, max: int }),
    freeActionMaxChars: int,
    truthTextMaxChars: int,
  }),
  stats: z.object({ min: int, max: int }),
  combat: z.object({
    diceCount: int,
    freeRerolls: int,
    passDiePerRound: int,
    tripleSkullDamage: int,
    targetRoundsPerEncounter: z.object({ min: z.number(), max: z.number() }),
  }),
  light: z.object({
    start: int,
    torches: int,
    torchValue: int,
    cost: z.object({ moveCellsPerUnit: int, check: int, combatRound: int, rest: int }),
    states: z.array(
      z.object({
        id: z.enum(["bright", "dusk", "dark", "gloom"]),
        min: int,
        vision: int,
        checkMod: int,
        enemyDamageBonus: int,
      }),
    ),
    gloomShadowEveryActions: int,
  }),
  doom: z.object({
    liveDmStart: int,
    perLightSpent: int,
    costs: z.object({ attackPlus: int, rearmTrap: int, reinforcement: int, collapse: int }),
    reinforcementBudget: int,
    collapseLightLoss: int,
    leftoverBossHpPerToken: int,
    autoDmPriority: z.array(z.enum(["attack_plus", "rearm_trap", "reinforcement", "collapse"])),
  }),
  deathSaves: z.object({ dc: int, successes: int, failures: int }),
  rest: z.object({ healPercent: int, maxCampfires: int }),
  progression: z.object({
    maxLevel: int,
    xpPerLevelFactor: int,
    hpBonusEvenLevels: int,
    freeHeroSlots: int,
    relicSlots: int,
    consumableSlots: int,
  }),
  scars: z.object({ max: int, choices: int, total: int }),
  rewards: z.object({ xpPerMonsterCost: int, xpVictoryPerTier: int, xpRetreatShare: int }),
  explore: z.object({ searchRadius: int, trapSpotAttr: attr, adjacent: int, maxPathCells: int, startConsumables: z.array(z.string()) }),
  partyHpScale: z.record(z.string(), z.number()),
  /** Боссы зовут подмогу и бьют сильнее — для малых партий их здоровье режется сильнее. */
  bossHpScale: z.record(z.string(), z.number()),
  tiers: z.array(
    z.object({ tier: int, heroLevels: z.tuple([int, int]), budget: int, maxPerRoom: int, maxMap: int, minHoard: int }),
  ),
  economy: z.object({
    entryFeePercentOfHoard: int,
    minEntryFee: int,
    victoryHoardPercent: int,
    commissionPercent: int,
    rewardCooldownDays: int,
    maxPairOutcomesPerWeek: int,
  }),
  timers: z.object({
    liveTurnSec: int,
    asyncTurnHoursOptions: z.array(int),
    asyncTurnHoursDefault: int,
    liveDmJoinSec: int,
    liveDmIdleSec: int,
    llmTimeoutSec: int,
  }),
  builder: z.object({
    maxRules: int,
    maxVariables: int,
    maxChainDepth: int,
    defaultRuleFireLimit: int,
    undoSteps: int,
    simRuns: int,
    minBotWinRatePercent: int,
    freePublishedSlots: int,
  }),
  loot: z.object({
    rarityWeights: z.record(z.string(), z.object({ common: int, rare: int, epic: int })),
    slots: z.object({ weapon: int, armor: int, relic: int }),
    marketCommissionPercent: int,
    marketMinPrice: int,
    marketMaxPrice: int,
    marketMaxListings: int,
  }),
  fallen: z.object({ maxPerDungeon: int, powerCapMultiplier: z.number(), heirLevelPenalty: int }),
  classes: z.array(ClassSchema),
  monsters: z.array(MonsterSchema),
  traps: z.array(TrapSchema),
  shopStars: z.record(z.string(), int.positive().nullable()),
});
export type Balance = z.infer<typeof BalanceSchema>;

/** Сценарий вертикального среза (этап 1). На этапе 2 заменяется DungeonDefinition. */
export const ScenarioSchema = z.object({
  id: z.string(),
  tutorial: z.boolean(),
  room: z.object({
    id: z.string(),
    corridor: z.object({ id: z.string(), cells: int.positive() }),
    trap: z.object({ id: z.string(), trapId: z.string() }),
    door: z.object({ id: z.string(), cells: int.positive() }),
  }),
  encounter: z.array(z.string()).min(1),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/** Постоянный эффект снаряжения. */
export const ItemEffectSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hp"), n: int.min(1).max(20) }),
  z.object({ t: z.literal("stat"), attr, n: int.min(1).max(2) }),
  z.object({ t: z.literal("dmg"), face: z.enum(["M", "L", "I"]), n: int.min(1).max(3) }),
  z.object({ t: z.literal("block"), n: int.min(1).max(5) }),
  z.object({ t: z.literal("heal_after"), n: int.min(1).max(10) }),
  z.object({ t: z.literal("light"), n: int.min(1).max(15) }),
  z.object({ t: z.literal("reroll"), n: int.min(1).max(2) }),
  z.object({ t: z.literal("poison"), n: int.min(1).max(2) }),
]);
export type ItemEffect = z.infer<typeof ItemEffectSchema>;

export const ItemSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("consumable"),
    name: z.string(),
    desc: z.string(),
    effect: z.enum(["heal", "light", "retreat"]),
    amount: int,
    combat: z.boolean(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("equipment"),
    slot: z.enum(["weapon", "armor", "relic"]),
    rarity: z.enum(["common", "rare", "epic"]),
    /** С какого уровня подземелий падает. */
    tier: int.min(1).max(3),
    name: z.string(),
    desc: z.string(),
    effects: z.array(ItemEffectSchema).min(1).max(4),
  }),
]);
export type Item = z.infer<typeof ItemSchema>;
export type EquipmentItem = Extract<Item, { kind: "equipment" }>;
