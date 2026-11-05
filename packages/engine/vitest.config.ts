import { defineConfig } from "vitest/config";

// Property-тесты гоняют сотни партий: под параллельной нагрузкой CI им нужно больше 5 секунд.
export default defineConfig({ test: { testTimeout: 120_000 } });
