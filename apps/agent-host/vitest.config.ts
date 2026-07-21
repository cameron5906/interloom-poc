import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "web/src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/__tests__/setup.ts"],
  },
});
