/**
 * Нагрузочный тест (ТЗ 14): N одновременных партий на одном экземпляре, p95 обработки команды.
 * Запуск: DATABASE_URL=... pnpm --filter @kf/api exec tsx scripts/load.ts 200
 */
import { randomUUID } from "node:crypto";
import { botStep } from "@kf/engine";
import { buildApp } from "../src/app.js";
import { signInitData } from "../src/auth/initData.js";
import { createDb, runMigrations } from "../src/db/client.js";
import { loadEnv } from "../src/env.js";

const N = Number(process.argv[2] ?? 200);
/** Пауза игрока между командами, мс (0 — без пауз, худший случай). */
const THINK = Number(process.argv[3] ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TOKEN = "123456:LOAD-token-abcdefghijklmnopqrstuvwxyz";
const env = loadEnv({ ...process.env, NODE_ENV: "test", BOT_TOKEN: TOKEN, BOT_USERNAME: "load_bot", SESSION_SECRET: "l".repeat(40) });
await runMigrations(env.DATABASE_URL);
const { db, close } = createDb(env.DATABASE_URL);
const app = await buildApp({ env, db });
await app.ready();

const lat: number[] = [];
async function party(i: number) {
  const remoteAddress = `10.1.${i >> 8}.${i & 255}`; // разные игроки — разные адреса
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 900000 + i, first_name: "L" }) }, TOKEN);
  const token = (await app.inject({ method: "POST", url: "/auth/telegram", payload: { initData }, remoteAddress })).json().token;
  const h = { authorization: `Bearer ${token}` };
  const cls = ["guardian", "rogue", "sorcerer", "healer"][i % 4];
  const heroId = (await app.inject({ method: "POST", url: "/heroes", headers: h, payload: { classId: cls } })).json().id;
  const id = (await app.inject({ method: "POST", url: "/sessions", headers: h, payload: { heroId, dungeonId: "tavern_cellar" } })).json().sessionId;
  let v = (await app.inject({ method: "GET", url: `/sessions/${id}/state`, headers: h })).json();
  let seq = v.seq;
  const cmd = async (c: object) => {
    if (THINK) await sleep(THINK * (0.5 + Math.random()));
    const t0 = performance.now();
    const r = await app.inject({ method: "POST", url: `/sessions/${id}/commands`, headers: h, payload: { ...c, commandId: randomUUID(), expectedSeq: seq } });
    lat.push(performance.now() - t0);
    const j = r.json();
    if (!j.ok) throw new Error(JSON.stringify(j));
    seq = j.seq;
    v = { ...v, state: j.state };
  };
  const memo = { searches: new Set<string>() };
  for (let g = 0; g < 2000; g++) {
    const full = await app.game.fullState(id);
    if (!full || full.phase === "ended") break;
    const c = botStep(full, "h1", memo);
    if (!c) break;
    await cmd(c);
  }
}

const t0 = performance.now();
await Promise.all(Array.from({ length: N }, (_, i) => party(i)));
lat.sort((a, b) => a - b);
const q = (p: number) => lat[Math.floor(lat.length * p)]!.toFixed(1);
console.log(`${N} партий, ${lat.length} команд за ${((performance.now() - t0) / 1000).toFixed(1)} с; p50 ${q(0.5)} мс, p95 ${q(0.95)} мс, p99 ${q(0.99)} мс`);
await app.close();
await close();
