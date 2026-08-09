/**
 * `node scripts/mark-noindex.mts <dir> [<dir>...]`
 *
 * Mark every HTML document under each directory `noindex, nofollow`, in place.
 * Used by `demo-preview.yml` on the marketing-site bundles it copies out of
 * `site/` into the `demo-previews` branch — those copies are published under
 * `/demo/`, while the same source files are deployed unmarked to the production
 * root from `main`. The demo build marks its own output in `build.mts`, so each
 * published artifact carries the tag from the step that produces it.
 *
 * See `lib/noindex.mts` for why this is a meta tag and not an HTTP header.
 */
import { markTreeNoindex } from './lib/noindex.mts'

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error('usage: node scripts/mark-noindex.mts <dir> [<dir>...]')
  process.exit(1)
}

for (const dir of dirs) {
  // No try/catch: an unreadable path or a document with no <head> means the
  // publish step is about to ship an indexable preview, which is the whole
  // thing this guards against. Fail the job.
  const marked = markTreeNoindex(dir)
  console.log(
    marked.length === 0
      ? `[noindex] ${dir}: already marked`
      : `[noindex] ${dir}: marked ${String(marked.length)} file(s)`,
  )
}
