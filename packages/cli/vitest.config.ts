import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // build-smoke.test.ts runs esbuild in beforeAll; the default 10s hook
    // timeout is too short on cold caches and slower machines. 30s also covers
    // spawn-based cases; a single case that needs more should override its own
    // timeout explicitly instead of raising this global value.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
