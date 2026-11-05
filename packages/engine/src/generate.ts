import { balance, biomes, eventLibrary } from "@kf/content";
import { DungeonDefinitionSchema, type DungeonDefinition, type DungeonObject, type Encounter, type EventDefinition } from "@kf/schema";
import { rollEquipment } from "./loot.js";
import { Pcg32, boundU32, seedFromHex } from "./rng.js";

/**
 * Генератор экспедиций: каждая вылазка — новая карта местности из того же формата DungeonDefinition,
 * поэтому движок, проверки и клиент работают с ней так же, как с авторскими подземельями.
 *
 * Карта — поляны (комнаты), соединённые тропами. Роли полян: вход, логово с сокровищницей и боссом,
 * стычки, сундуки, костёр, события с выбором. Вода, пропасти и ловушки зависят от биома.
 * Детерминирован: одно зерно — одна карта. Зерно секретное, как и зерно бросков.
 */
export interface ExpeditionParams {
  seedHex: string;
  biome: string;
  tier: 1 | 2 | 3;
  /** Размер партии: одиночке и двоим — меньше стычек до логова. */
  partySize?: number;
}

interface Clearing {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

class R {
  private p: Pcg32;
  constructor(seedHex: string, salt: number) {
    this.p = new Pcg32(seedFromHex(seedHex), 1000n + BigInt(salt));
  }
  int(n: number): number {
    return boundU32(this.p.nextU32(), n);
  }
  range(a: number, b: number): number {
    return a + this.int(b - a + 1);
  }
  chance(p: number): boolean {
    return this.int(10000) < p * 10000;
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)]!;
  }
  shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
}

const SIZE = { 1: 22, 2: 26, 3: 30 } as const;
const N4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const CROSS: [number, number][] = [[0, 0], ...N4];
const CLEARINGS = { 1: 7, 2: 8, 3: 9 } as const;

export function generateExpedition(params: ExpeditionParams): DungeonDefinition {
  for (let attempt = 0; attempt < 20; attempt++) {
    const def = tryGenerate(params, attempt);
    if (def) return def;
  }
  throw new Error("expedition generation failed");
}

function tryGenerate({ seedHex, biome: biomeId, tier, partySize = 4 }: ExpeditionParams, attempt: number): DungeonDefinition | null {
  const biome = biomes.find((b) => b.id === biomeId);
  if (!biome) throw new Error(`unknown biome ${biomeId}`);
  const r = new R(seedHex, attempt);
  const W = SIZE[tier];
  const H = SIZE[tier];
  const g: string[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => "#"));
  const set = (x: number, y: number, c: string) => {
    if (x > 0 && y > 0 && x < W - 1 && y < H - 1) g[y]![x] = c;
  };

  // 1. Поляны.
  const cl: Clearing[] = [];
  for (let i = 0; i < 600 && cl.length < CLEARINGS[tier]; i++) {
    const rx = r.range(2, tier === 3 ? 4 : 3);
    const ry = r.range(2, tier === 3 ? 4 : 3);
    const cx = r.range(rx + 1, W - rx - 2);
    const cy = r.range(ry + 1, H - ry - 2);
    if (cl.some((c) => Math.hypot(c.cx - cx, c.cy - cy) < Math.max(c.rx, c.ry) + Math.max(rx, ry) + 3)) continue;
    cl.push({ cx, cy, rx, ry });
  }
  if (cl.length < 5) return null;
  const inClearing = (c: Clearing, x: number, y: number) => ((x - c.cx) / (c.rx + 0.5)) ** 2 + ((y - c.cy) / (c.ry + 0.5)) ** 2 <= 1;
  for (const c of cl)
    for (let y = c.cy - c.ry; y <= c.cy + c.ry; y++) for (let x = c.cx - c.rx; x <= c.cx + c.rx; x++) if (inClearing(c, x, y)) set(x, y, ".");

  // 2. Связи: минимальное остовное дерево + пара лишних троп для кругов.
  const edges: [number, number][] = [];
  const inTree = new Set([0]);
  while (inTree.size < cl.length) {
    let best: [number, number, number] | null = null;
    for (const a of inTree)
      for (let b = 0; b < cl.length; b++) {
        if (inTree.has(b)) continue;
        const d = Math.hypot(cl[a]!.cx - cl[b]!.cx, cl[a]!.cy - cl[b]!.cy);
        if (!best || d < best[2]) best = [a, b, d];
      }
    edges.push([best![0], best![1]]);
    inTree.add(best![1]);
  }
  for (let k = 0; k < 2; k++) {
    const a = r.int(cl.length);
    const b = r.int(cl.length);
    if (a !== b && !edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a)) && Math.hypot(cl[a]!.cx - cl[b]!.cx, cl[a]!.cy - cl[b]!.cy) < W * 0.6)
      edges.push([a, b]);
  }
  const pathCells = new Set<string>();
  for (const [a, b] of edges) {
    let x = cl[a]!.cx;
    let y = cl[a]!.cy;
    const tx = cl[b]!.cx;
    const ty = cl[b]!.cy;
    for (let guard = 0; guard < 400 && (x !== tx || y !== ty); guard++) {
      const dx = tx - x;
      const dy = ty - y;
      if (r.chance(0.15)) {
        // Тропа петляет.
        if (r.chance(0.5)) y += r.chance(0.5) ? 1 : -1;
        else x += r.chance(0.5) ? 1 : -1;
        x = Math.max(1, Math.min(W - 2, x));
        y = Math.max(1, Math.min(H - 2, y));
      } else if (Math.abs(dx) > 0 && (Math.abs(dy) === 0 || r.int(Math.abs(dx) + Math.abs(dy)) < Math.abs(dx))) x += Math.sign(dx);
      else y += Math.sign(dy);
      if (g[y]![x] === "#") pathCells.add(`${x},${y}`);
      set(x, y, ".");
      if ((biome.id === "forest" || biome.id === "swamp") && r.chance(0.25)) set(x + 1, y, ".");
    }
  }

  // 3. Роли полян: вход и логово — самые далёкие друг от друга.
  const entranceIdx = r.int(cl.length);
  const dist = bfs(g, cl[entranceIdx]!.cx, cl[entranceIdx]!.cy);
  const order = cl.map((c, i) => ({ i, d: dist.get(`${c.cx},${c.cy}`) ?? -1 })).sort((a, b) => a.d - b.d);
  if (order.some((o) => o.d < 0)) return null;
  const goalIdx = order[order.length - 1]!.i;
  const middle = order.slice(1, -1).map((o) => o.i);

  // 4. Вода и пропасти внутри полян (кроме центра и входа), без потери связности.
  const keep = new Set<string>();
  for (const c of cl) for (const [dx, dy] of CROSS) keep.add(`${c.cx + dx},${c.cy + dy}`);
  for (const c of cl) {
    for (let y = c.cy - c.ry; y <= c.cy + c.ry; y++)
      for (let x = c.cx - c.rx; x <= c.cx + c.rx; x++) {
        if (g[y]?.[x] !== "." || keep.has(`${x},${y}`) || pathCells.has(`${x},${y}`)) continue;
        if (r.chance(biome.water)) g[y]![x] = "~";
        else if (r.chance(biome.chasm)) {
          g[y]![x] = "_";
          if (!allReachable(g, cl)) g[y]![x] = ".";
        } else if (biome.id !== "dungeon" && r.chance(0.07)) {
          // Одиночные деревья, валуны, колонны внутри полян.
          g[y]![x] = "#";
          if (!allReachable(g, cl)) g[y]![x] = ".";
        }
      }
  }

  const tiles = g.map((row) => row.join(""));
  const objects: DungeonObject[] = [];
  const encounters: Encounter[] = [];
  const texts: Record<string, string> = { intro: r.pick(biome.texts.intro) };
  const used = new Set<string>();
  const free = (x: number, y: number) => (tiles[y]![x] === "." || tiles[y]![x] === "~") && !used.has(`${x},${y}`);
  const place = (o: DungeonObject) => {
    used.add(`${o.x},${o.y}`);
    objects.push(o);
  };
  const spotIn = (c: Clearing): [number, number] | null => {
    const cand: [number, number][] = [];
    for (let y = c.cy - c.ry; y <= c.cy + c.ry; y++) for (let x = c.cx - c.rx; x <= c.cx + c.rx; x++) if (tiles[y]?.[x] === "." && free(x, y)) cand.push([x, y]);
    return cand.length ? r.pick(cand) : null;
  };
  const zoneOf = (c: Clearing) => ({ x: Math.max(0, c.cx - c.rx), y: Math.max(0, c.cy - c.ry), w: c.rx * 2 + 1, h: c.ry * 2 + 1 });

  const ent = cl[entranceIdx]!;
  place({ id: "entrance", type: "entrance", x: ent.cx, y: ent.cy });

  // 5. Логово: босс и сокровищница.
  const goal = cl[goalIdx]!;
  place({ id: "treasury", type: "treasury", x: goal.cx, y: goal.cy, textId: "treasury" });
  texts.treasury = r.pick(biome.texts.treasury);
  texts.boss = r.pick(biome.texts.boss);
  const tierDef = balance.tiers.find((t) => t.tier === tier)!;
  const cost = (kinds: string[]) => kinds.reduce((n, k) => n + (balance.monsters.find((m) => m.id === k)?.cost ?? 0), 0);
  // Одиночке — вожак без свиты: усиленная обычная группа. С двумя и больше — настоящий босс.
  const boss = partySize >= 2 ? [...r.pick(biome.bosses)] : [...r.pick(biome.groups)];
  encounters.push({ id: "lair", zone: zoneOf(goal), monsters: boss, textId: "boss", boss: true });
  let budget = tierDef.budget - cost(boss);

  // 6. Остальные поляны.
  const roles = r.shuffle([...middle]);
  const campfireIdx = middle[Math.floor(middle.length / 2)];
  const degree = (i: number) => edges.filter(([a, b]) => a === i || b === i).length;
  const deadEnds = roles.filter((i) => degree(i) === 1 && i !== campfireIdx);
  const fightCount = Math.min(roles.length - 1, tier + (partySize >= 3 ? 1 : 0));
  const fights = roles.filter((i) => i !== campfireIdx).slice(0, fightCount);
  let enc = 0;
  for (const i of fights) {
    const group = [...r.pick(biome.groups)];
    if (tier >= 2) group.push(r.pick(r.pick(biome.groups)));
    while (group.length > 1 && (cost(group) > tierDef.maxPerRoom || cost(group) > budget)) group.pop();
    if (cost(group) > budget) break;
    budget -= cost(group);
    const id = `fight_${++enc}`;
    texts[id] = r.pick(biome.texts.encounter);
    encounters.push({ id, zone: zoneOf(cl[i]!), monsters: group, textId: id, boss: false });
  }
  if (campfireIdx !== undefined) {
    const spot = spotIn(cl[campfireIdx]!);
    if (spot) place({ id: "campfire", type: "campfire", x: spot[0], y: spot[1] });
  }
  const chestRooms = [...deadEnds, ...fights].filter((v, k, a) => a.indexOf(v) === k).slice(0, 2 + (tier >= 2 ? 1 : 0));
  chestRooms.forEach((i, k) => {
    const spot = spotIn(cl[i]!);
    if (spot) place({ id: `chest_${k + 1}`, type: "chest", x: spot[0], y: spot[1], loot: chestLoot(r, tier) });
  });
  // В логове — второй сундук побогаче.
  const lairSpot = spotIn(goal);
  if (lairSpot) place({ id: "chest_lair", type: "chest", x: lairSpot[0], y: lairSpot[1], loot: chestLoot(r, tier, true) });

  // 7. События с выбором: на свободных полянах и на тропах.
  const pool = r.shuffle(eventLibrary.filter((e) => e.biomes.includes(biome.id) || e.biomes.includes("any")));
  const events: EventDefinition[] = [];
  const eventSpots: [number, number][] = [];
  for (const i of roles.filter((x) => !fights.includes(x))) {
    const s = spotIn(cl[i]!);
    if (s) eventSpots.push(s);
  }
  const pathList = [...pathCells].map((k) => k.split(",").map(Number) as [number, number]).filter(([x, y]) => free(x, y) && !inAnyZone(encounters, x, y));
  while (eventSpots.length < 3 && pathList.length) eventSpots.push(pathList.splice(r.int(pathList.length), 1)[0]!);
  for (const [x, y] of eventSpots.slice(0, 2 + tier)) {
    const ev = pool.shift();
    if (!ev) break;
    const { biomes: _b, ...plain } = ev;
    events.push(plain);
    place({ id: `ev_${events.length}`, type: "event", x, y, eventId: ev.id });
  }

  // 8. Скрытые ловушки на узких тропах, не у входа.
  const narrow = [...pathCells]
    .map((k) => k.split(",").map(Number) as [number, number])
    .filter(([x, y]) => free(x, y) && tiles[y]![x] === "." && Math.hypot(x - ent.cx, y - ent.cy) > 4 && !inAnyZone(encounters, x, y))
    .filter(([x, y]) => N4.filter(([dx, dy]) => tiles[y + dy]![x + dx] !== "#").length <= 2);
  for (let k = 0; k < 1 + tier && narrow.length; k++) {
    const [x, y] = narrow.splice(r.int(narrow.length), 1)[0]!;
    place({ id: `trap_${k + 1}`, type: "trap", x, y, trapId: r.pick(biome.traps), hidden: true });
  }

  const def = DungeonDefinitionSchema.safeParse({
    schemaVersion: 1,
    id: `exp_${biome.id}`,
    title: biome.name,
    tier,
    tutorial: false,
    biome: biome.id,
    generated: true,
    size: { w: W, h: H },
    tiles,
    objects,
    encounters,
    npcs: [],
    rules: [],
    variables: [],
    events,
    texts,
  });
  if (!def.success) return null;
  // Сокровищница и все объекты достижимы от входа.
  const reach = bfs(g, ent.cx, ent.cy);
  if (!objects.every((o) => reach.has(`${o.x},${o.y}`))) return null;
  return def.data;
}

function inAnyZone(encs: Encounter[], x: number, y: number): boolean {
  return encs.some((e) => x >= e.zone.x && y >= e.zone.y && x < e.zone.x + e.zone.w && y < e.zone.y + e.zone.h);
}

function chestLoot(r: R, tier: number, rich = false): { gold: number; items: string[] } {
  const gold = r.range(8, 18) * tier * (rich ? 2 : 1);
  const items: string[] = [];
  if (r.chance(0.6)) items.push(r.chance(0.6) ? "potion" : "torch");
  if (rich || r.chance(0.3)) items.push(...relicDrop(r, tier, rich));
  return { gold, items };
}

/** Снаряжение из сундука: в логове — всегда, в остальных — с шансом. */
function relicDrop(r: R, tier: number, rich: boolean): string[] {
  return [rollEquipment((n) => r.int(n), tier, rich)];
}

function bfs(g: string[][], sx: number, sy: number): Map<string, number> {
  const d = new Map<string, number>([[`${sx},${sy}`, 0]]);
  const q: [number, number][] = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift()!;
    for (const [dx, dy] of N4) {
      const nx = x + dx;
      const ny = y + dy;
      const k = `${nx},${ny}`;
      const t = g[ny]?.[nx];
      if (d.has(k) || (t !== "." && t !== "~")) continue;
      d.set(k, d.get(`${x},${y}`)! + 1);
      q.push([nx, ny]);
    }
  }
  return d;
}

function allReachable(g: string[][], cl: Clearing[]): boolean {
  const d = bfs(g, cl[0]!.cx, cl[0]!.cy);
  return cl.every((c) => d.has(`${c.cx},${c.cy}`));
}
