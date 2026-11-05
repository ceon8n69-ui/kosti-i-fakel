import { runMigrations } from "./client.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL не задан");
await runMigrations(url);
console.log("migrations applied");
