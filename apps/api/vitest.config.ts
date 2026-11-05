import { defineConfig } from "vitest/config";

// Интеграционные тесты делят одну тестовую БД и очищают её — файлы идут по очереди.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 30_000 } });
