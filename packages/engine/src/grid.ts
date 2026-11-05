import type { RObject, SessionState, VisibleObject } from "./types.js";

export type Cell = [number, number];
export const key = (x: number, y: number) => `${x},${y}`;
export const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

export const tileAt = (s: SessionState, x: number, y: number): string => s.tiles[y]?.[x] ?? "#";
export const isSeen = (s: SessionState, x: number, y: number): boolean => s.seen[y]?.[x] === "1";
export const objectsAt = (s: SessionState, x: number, y: number): RObject[] => s.objects.filter((o) => o.x === x && o.y === y);

/** Дверь закрыта или ещё не найдена (секретная). Такая клетка — стена для движения и взгляда. */
export function blockedByObject(s: SessionState, x: number, y: number): boolean {
  return objectsAt(s, x, y).some((o) => o.type === "door" && (!o.open || o.hidden));
}

export function passable(s: SessionState, x: number, y: number): boolean {
  const t = tileAt(s, x, y);
  return (t === "." || t === "~") && !blockedByObject(s, x, y);
}

export const opaque = (s: SessionState, x: number, y: number): boolean => {
  const t = tileAt(s, x, y);
  return t === "#" || t === " " || blockedByObject(s, x, y);
};

/** Видна ли клетка из точки: луч Брезенхема не проходит через стены и закрытые двери. */
export function lineOfSight(s: SessionState, x0: number, y0: number, x1: number, y1: number): boolean {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (!(x === x1 && y === y1)) {
    if (!(x === x0 && y === y0) && opaque(s, x, y)) return false;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return true;
}

/** Клетки в радиусе обзора (круг) с прямой видимостью. */
export function visibleFrom(s: SessionState, x0: number, y0: number, radius: number): Cell[] {
  const out: Cell[] = [];
  const { w, h } = s.def.size;
  for (let y = Math.max(0, y0 - radius); y <= Math.min(h - 1, y0 + radius); y++)
    for (let x = Math.max(0, x0 - radius); x <= Math.min(w - 1, x0 + radius); x++) {
      if ((x - x0) ** 2 + (y - y0) ** 2 > radius * radius + radius) continue;
      if (lineOfSight(s, x0, y0, x, y)) out.push([x, y]);
    }
  return out;
}

/** Кратчайший путь по уже открытым проходимым клеткам (8 направлений, без срезания углов). */
export function findPath(
  s: SessionState,
  from: Cell,
  to: Cell,
  avoid: (x: number, y: number) => boolean,
  max: number,
): Cell[] | null {
  const [tx, ty] = to;
  if (!isSeen(s, tx, ty) || !passable(s, tx, ty)) return null;
  const prev = new Map<string, string | null>([[key(...from), null]]);
  let frontier: Cell[] = [from];
  for (let depth = 0; depth < max && frontier.length; depth++) {
    const next: Cell[] = [];
    for (const [x, y] of frontier) {
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        const k = key(nx, ny);
        if (prev.has(k) || !isSeen(s, nx, ny) || !passable(s, nx, ny)) continue;
        if (dx && dy && (!passable(s, x + dx, y) || !passable(s, x, y + dy))) continue; // угол
        if (!(nx === tx && ny === ty) && avoid(nx, ny)) continue;
        prev.set(k, key(x, y));
        if (nx === tx && ny === ty) {
          const path: Cell[] = [];
          let cur: string | null = k;
          while (cur && cur !== key(...from)) {
            const [px, py] = cur.split(",").map(Number) as Cell;
            path.unshift([px, py]);
            cur = prev.get(cur) ?? null;
          }
          return path;
        }
        next.push([nx, ny]);
      }
    }
    frontier = next;
  }
  return null;
}

const DIRS: Cell[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Номер комнаты: связная область пола, где двери считаются стенами.
 * Используется для смены Ведущего и лимитов бюджета на комнату.
 */
export function roomOf(s: SessionState, x: number, y: number): number {
  const doors = new Set(s.objects.filter((o) => o.type === "door").map((o) => key(o.x, o.y)));
  const floor = (cx: number, cy: number) => {
    const t = s.def.tiles[cy]?.[cx];
    return (t === "." || t === "~") && !doors.has(key(cx, cy));
  };
  if (!floor(x, y)) return -1;
  // Номер — индекс самой верхней левой клетки комнаты.
  const seen = new Set([key(x, y)]);
  const queue: Cell[] = [[x, y]];
  let best = y * 64 + x;
  while (queue.length) {
    const [cx, cy] = queue.pop()!;
    best = Math.min(best, cy * 64 + cx);
    for (const [dx, dy] of DIRS.slice(0, 4)) {
      const k = key(cx + dx, cy + dy);
      if (!seen.has(k) && floor(cx + dx, cy + dy)) {
        seen.add(k);
        queue.push([cx + dx, cy + dy]);
      }
    }
  }
  return best;
}

/** Как объект выглядит для игрока. */
export function visibleObject(o: RObject): VisibleObject {
  const v: VisibleObject = { id: o.id, type: o.type, x: o.x, y: o.y };
  if (o.open !== undefined) v.open = o.open;
  if (o.locked !== undefined) v.locked = o.locked;
  if (o.state !== undefined) v.state = o.state;
  if (o.trapId !== undefined) v.trapId = o.trapId;
  if (o.used !== undefined) v.used = o.used;
  if (o.npcId !== undefined) v.npcId = o.npcId;
  if (o.radius !== undefined) v.radius = o.radius;
  if (o.event !== undefined) v.event = o.event;
  return v;
}

/** Плитка для игрока: ненайденная секретная дверь выглядит стеной. */
export function visibleTile(s: SessionState, x: number, y: number): string {
  if (objectsAt(s, x, y).some((o) => o.type === "door" && o.hidden)) return "#";
  return tileAt(s, x, y);
}
