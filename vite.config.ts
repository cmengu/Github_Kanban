import { defineConfig } from 'vitest/config'

// Static site, no backend (#12). Relative base so the built page works from any
// GitHub Pages sub-path without a rebuild.
export default defineConfig({
  base: './',
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
