import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the vendored blockviz build (vendor/blockviz/README.md) lives: a
 * packaged app gets it copied into resources/ by a future fetch step
 * (scripts/fetch-blockviz.mts, tracked in vendor/blockviz/README.md — not
 * implemented yet, since it needs a published release to fetch); a dev
 * checkout serves vendor/blockviz/dist/ directly once `npm run build` has
 * been run there.
 */
export function bundledBlockvizDistPath(): string | null {
  for (const candidate of [
    join(__dirname, '../resources/blockviz'),
    join(__dirname, '../../vendor/blockviz/dist'),
  ]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return null
}
