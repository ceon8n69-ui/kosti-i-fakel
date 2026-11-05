import { itemById } from "@kf/content";
import { autoTurn } from "./auto.js";
import { canPath } from "./explore.js";
import { cheb, isSeen, passable } from "./grid.js";
import type { CommandBody, RObject, SessionState } from "./types.js";

/**
 * Бот-исследователь: простой, но доводит обучающие подземелья до конца.
 * Используется в тестах проходимости и симуляторе. Видит только то же, что игрок,
 * плюс полное состояние объектов (как автоматический мастер) — секреты ищет обыском.
 */
export function botStep(s: SessionState, heroId: string, memo: { searches: Set<string>; danger?: boolean; waits?: number } = { searches: new Set() }): CommandBody | null {
  const h = s.heroes.find((x) => x.id === heroId);
  if (!h || s.phase === "ended") return null;
  if (s.phase === "combat") {
    if (h.status !== "up") return null;
    // Зелье, если герой почти пал.
    if (h.hp <= 3 && !h.ready && s.bag.items.includes("potion") && h.hp < h.maxHp) return { type: "USE_ITEM", heroId, itemId: "potion" };
    // Берём первый шаг автохода, который ещё не сделан.
    for (const c of autoTurn(s, heroId)) {
      if (c.type === "ASSIGN_FACE" && h.plan.some((a) => a.die === c.die && a.target === c.target && a.star === c.star)) continue;
      return c;
    }
    return null;
  }
  if (h.status !== "up") return null;
  const leader = s.leaderId === heroId;
  const up = s.heroes.filter((x) => x.status === "up");
  const downed = s.heroes.find((x) => x.status === "downed");
  if (downed && s.bag.items.includes("potion")) return { type: "USE_ITEM", heroId, itemId: "potion", targetId: downed.id };
  const hurt = up.find((x) => x.hp < x.maxHp * 0.45);
  if (hurt && s.bag.items.includes("potion")) return { type: "USE_ITEM", heroId, itemId: "potion", targetId: hurt.id };
  if (s.light < 12 && s.bag.items.includes("torch")) return { type: "USE_ITEM", heroId, itemId: "torch" };

  const vis = (o: RObject) => !o.hidden && isSeen(s, o.x, o.y);
  const near = (o: RObject) => cheb(s.pos.x, s.pos.y, o.x, o.y) <= 1;
  const want = (o: RObject): boolean => {
    if (!vis(o)) return false;
    switch (o.type) {
      case "key":
      case "chest":
      case "lever":
      case "altar":
      case "npc":
        return !o.used && !(o.type === "chest" && o.locked && !(o.keyId && s.bag.keys.includes(o.keyId)) && !o.lockDc);
      case "campfire":
        return !o.used && up.some((x) => x.hp < x.maxHp * 0.6);
      case "door":
        return !o.open;
      case "trap":
        return o.state === "revealed";
      case "treasury":
        return true;
      case "event":
        // Развилка экспедиции: бот идёт дальше (опасной тропой, если так задано).
        return o.eventId === "crossroads" && !o.used;
      default:
        return false;
    }
  };

  const targets = s.objects.filter(want);
  // Сначала то, что рядом.
  for (const o of targets.filter(near).sort(order)) {
    if (o.type === "trap") return { type: "INTERACT", heroId, objectId: o.id, verb: "disarm" };
    if ((o.type === "door" || o.type === "chest") && o.locked && !(o.keyId && s.bag.keys.includes(o.keyId)))
      return o.lockDc ? { type: "INTERACT", heroId, objectId: o.id, verb: "force" } : null;
    if (o.type === "campfire") return { type: "REST", heroId, objectId: o.id };
    if (o.type === "event") {
      // Сначала всё ценное на карте, потом развилка.
      // (если что-то ценное недостижимо — не ждём вечно).
      memo.waits = (memo.waits ?? 0) + 1;
      if (memo.waits < 30 && targets.some((x) => x.type !== "event" && x.type !== "trap" && x.type !== "door")) continue;
      memo.waits = 0;
      return { type: "CHOOSE_OPTION", heroId, objectId: o.id, optionId: memo.danger ? "danger" : "go" };
    }
    if (o.type === "treasury" && s.objects.some((x) => x.type === "key" && !x.used && vis(x))) continue;
    return { type: "INTERACT", heroId, objectId: o.id, verb: "use" };
  }
  if (!leader) return null;
  // Идём к ближайшей цели рядом с которой можно встать.
  let best: { x: number; y: number; d: number } | null = null;
  for (const o of targets.sort(order)) {
    for (const [dx, dy] of NEAR) {
      const x = o.x + dx;
      const y = o.y + dy;
      if (!isSeen(s, x, y) || !passable(s, x, y) || (x === s.pos.x && y === s.pos.y)) continue;
      const p = canPath(s, x, y);
      if (p && (!best || p.length < best.d)) best = { x, y, d: p.length };
    }
    if (best) return { type: "MOVE", heroId, x: best.x, y: best.y };
  }
  // Граница тумана: ближайшая открытая клетка рядом с неоткрытой.
  let frontier: { x: number; y: number; d: number } | null = null;
  for (let y = 0; y < s.def.size.h; y++)
    for (let x = 0; x < s.def.size.w; x++) {
      if (!isSeen(s, x, y) || !passable(s, x, y) || (x === s.pos.x && y === s.pos.y)) continue;
      if (!NEAR.some(([dx, dy]) => !isSeen(s, x + dx, y + dy) && (s.tiles[y + dy]?.[x + dx] ?? "#") !== "#")) continue;
      const p = canPath(s, x, y);
      if (p && (!frontier || p.length < frontier.d)) frontier = { x, y, d: p.length };
    }
  if (frontier) return { type: "MOVE", heroId, x: frontier.x, y: frontier.y };
  // Тупик: обыскать здесь, потом пройти к непрочёсанным местам.
  const here = `${s.stage}:${s.pos.x},${s.pos.y}`;
  if (!memo.searches.has(here)) {
    memo.searches.add(here);
    return { type: "SEARCH", heroId };
  }
  for (let y = 0; y < s.def.size.h; y++)
    for (let x = 0; x < s.def.size.w; x++) {
      if (memo.searches.has(`${s.stage}:${x},${y}`) || !isSeen(s, x, y) || !passable(s, x, y)) continue;
      if (!NEAR.some(([dx, dy]) => s.tiles[y + dy]?.[x + dx] === "#")) continue;
      if (canPath(s, x, y)) return { type: "MOVE", heroId, x, y };
    }
  return null;
}

const ORDER: Record<string, number> = { key: 0, lever: 1, chest: 2, npc: 3, altar: 4, trap: 5, campfire: 6, door: 7, treasury: 8, event: 9 };
const order = (a: RObject, b: RObject) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9);

const NEAR: [number, number][] = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export const usableItem = (id: string) => itemById(id);
