import { describe, expect, it } from "vitest";
import { Pcg32, Rng, valueAt } from "./rng.js";

describe("PCG32", () => {
  it("совпадает с эталоном pcg32 (initstate=42, initseq=54)", () => {
    const p = new Pcg32(42n, 54n);
    const out = Array.from({ length: 6 }, () => p.nextU32().toString(16));
    expect(out).toEqual(["a15c02b7", "7b47f409", "ba1d3330", "83d2f293", "bfa4784b", "cbed606e"]);
  });

  it("advance(n) равен n последовательным шагам", () => {
    const a = new Pcg32(123456789n);
    for (let i = 0; i < 1000; i++) a.nextU32();
    const b = new Pcg32(123456789n);
    b.advance(1000n);
    expect(b.nextU32()).toBe(a.nextU32());
  });

  it("Rng записывает броски и они проверяются по зерну", () => {
    const seed = "0123456789abcdef";
    const r = new Rng(seed, 5);
    const vals = [r.int(20), r.int(6), r.int(12)];
    const draws = r.takeDraws();
    expect(draws.map((d) => d[0])).toEqual([5, 6, 7]);
    for (const [i, n, v] of draws) expect(valueAt(seed, i, n)).toBe(v);
    expect(draws.map((d) => d[2])).toEqual(vals);
  });

  it("d20 примерно равномерен", () => {
    const r = new Rng("00000000000000ff", 0);
    const counts = new Array(20).fill(0);
    for (let i = 0; i < 20000; i++) counts[r.int(20)]++;
    for (const c of counts) expect(Math.abs(c - 1000)).toBeLessThan(150);
  });
});
