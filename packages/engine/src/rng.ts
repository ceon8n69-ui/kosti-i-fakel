/**
 * PCG32 (XSH-RR, 64-битное состояние). Зерно партии + счётчик бросков однозначно задают
 * каждое случайное число: значение с индексом i = i-й выход генератора, засеянного зерном.
 * Движок не использует Math.random и время.
 */
const MASK = (1n << 64n) - 1n;
const MULT = 6364136223846793005n;
/** Фиксированный поток: разные партии различаются только зерном. */
export const PCG_STREAM = 54n;

export class Pcg32 {
  private state = 0n;
  private readonly inc: bigint;

  constructor(seed: bigint, stream: bigint = PCG_STREAM) {
    this.inc = ((stream << 1n) | 1n) & MASK;
    this.step();
    this.state = (this.state + (seed & MASK)) & MASK;
    this.step();
  }

  private step(): void {
    this.state = (this.state * MULT + this.inc) & MASK;
  }

  nextU32(): number {
    const old = this.state;
    this.step();
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn);
    const rot = Number(old >> 59n);
    return ((xorshifted >>> rot) | (xorshifted << (-rot & 31))) >>> 0;
  }

  /** Перемотка на delta шагов за O(log delta). */
  advance(delta: bigint): void {
    let accMult = 1n;
    let accPlus = 0n;
    let curMult = MULT;
    let curPlus = this.inc;
    let d = delta & MASK;
    while (d > 0n) {
      if (d & 1n) {
        accMult = (accMult * curMult) & MASK;
        accPlus = (accPlus * curMult + curPlus) & MASK;
      }
      curPlus = ((curMult + 1n) * curPlus) & MASK;
      curMult = (curMult * curMult) & MASK;
      d >>= 1n;
    }
    this.state = (accMult * this.state + accPlus) & MASK;
  }
}

export const seedFromHex = (hex: string): bigint => {
  if (!/^[0-9a-f]{16}$/.test(hex)) throw new Error("seed must be 16 hex chars");
  return BigInt(`0x${hex}`);
};

/** Число в [0, n) из 32-битного выхода: умножение со сдвигом, смещение ≤ n/2^32. */
export const boundU32 = (u: number, n: number): number => Math.floor((u * n) / 4294967296);

/** Запись одного броска в событии: [индекс, верхняя граница, значение]. Нужна для проверки журнала. */
export type Draw = [index: number, bound: number, value: number];

/** Генератор, привязанный к партии: знает свой индекс и записывает каждый бросок. */
export class Rng {
  private readonly pcg: Pcg32;
  private index: number;
  private drawn: Draw[] = [];

  constructor(seedHex: string, counter: number) {
    this.pcg = new Pcg32(seedFromHex(seedHex));
    this.pcg.advance(BigInt(counter));
    this.index = counter;
  }

  get counter(): number {
    return this.index;
  }

  int(n: number): number {
    if (!Number.isInteger(n) || n < 1) throw new Error(`bad bound ${n}`);
    const v = boundU32(this.pcg.nextU32(), n);
    this.drawn.push([this.index, n, v]);
    this.index++;
    return v;
  }

  /** Забирает записанные с прошлого вызова броски — они кладутся в событие. */
  takeDraws(): Draw[] {
    const d = this.drawn;
    this.drawn = [];
    return d;
  }
}

/** Значение броска с индексом i для данного зерна. Используется при проверке журнала. */
export function valueAt(seedHex: string, index: number, bound: number): number {
  const p = new Pcg32(seedFromHex(seedHex));
  p.advance(BigInt(index));
  return boundU32(p.nextU32(), bound);
}
