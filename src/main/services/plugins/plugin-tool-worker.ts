/**
 * Bundle entry for the standalone plugin-tool worker (`dist/main/plugin-tool-worker.js`,
 * see `scripts/main-bundles.mts`). The worker itself lives in `@copse/plugin-sdk`;
 * this entry exists so the build, the stdout-protocol guard, and the host's
 * `join(__dirname, 'plugin-tool-worker.js')` lookup keep one stable path. Keep it
 * free of Electron imports.
 */
import '@copse/plugin-sdk/plugin-tool-worker.ts'
