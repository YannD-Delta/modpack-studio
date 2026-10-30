import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx', 'tests/api/**/*.test.ts'],
    testTimeout: 30000,
    pool: 'forks',
    // Tests that omit dataDir must never read or write the real ./data folder.
    // One folder per run, so concurrent runs never share state.
    env: { STUDIO_DATA: path.join(os.tmpdir(), `modpack-studio-vitest-${process.pid}`) },
  },
});
