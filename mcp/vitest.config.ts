import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../frontend/src", import.meta.url)) } },
  // Each archive takes seconds to parse: several files loading theirs at once
  // outrun the default 10 s hook timeout, so test files run one at a time.
  test: { testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false },
})
