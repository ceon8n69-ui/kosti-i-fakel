import { valueAt } from "./rng.js";
import type { GameEvent } from "./types.js";

export interface VerifyReport {
  ok: boolean;
  checked: number;
  /** Первые расхождения: индекс броска, записанное и ожидаемое значение. */
  mismatches: { seq: number; index: number; recorded: number; expected: number }[];
  /** Индексы бросков идут подряд без пропусков. */
  contiguous: boolean;
}

/**
 * Проверка журнала после похода: каждый бросок в событиях пересчитывается из раскрытого зерна.
 * Хеш зерна (sha256) сверяется отдельно — средствами среды (node:crypto / SubtleCrypto).
 */
export function verifyJournal(seedHex: string, events: GameEvent[]): VerifyReport {
  const mismatches: VerifyReport["mismatches"] = [];
  let checked = 0;
  let next = 0;
  let contiguous = true;
  for (const ev of events) {
    for (const [index, bound, value] of ev.draws ?? []) {
      if (index !== next) contiguous = false;
      next = index + 1;
      checked++;
      const expected = valueAt(seedHex, index, bound);
      if (expected !== value && mismatches.length < 20) mismatches.push({ seq: ev.seq, index, recorded: value, expected });
    }
  }
  return { ok: mismatches.length === 0 && contiguous, checked, mismatches, contiguous };
}
