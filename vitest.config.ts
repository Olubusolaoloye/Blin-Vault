import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'services/**/*.test.ts'],
    environment: 'node',
    /* No rendering environment, deliberately. If a test needs one, the logic
       under test is in the wrong layer (ARCHITECTURE.md §8). */
  },
})
