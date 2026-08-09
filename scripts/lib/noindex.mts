/**
 * Keep machine-published preview builds out of search results.
 *
 * Everything under `copse.dev/demo/` is build output: the browser demos
 * (`/demo/main/`, `/demo/release/`, `/demo/pr-<n>/`) and the marketing-site
 * bundles published beside them (`/demo/main/preview/`, `/demo/pr-<n>-preview/`).
 * They are byte-for-byte near-duplicates of the production site and of each
 * other, they appear and vanish with pull requests, and their links are public
 * (the sticky PR comment is on a crawlable github.com page). Indexed, they
 * compete with `copse.dev/` for its own copy and leave dead `/demo/pr-<n>/`
 * results behind long after the PR closed.
 *
 * The production marketing site at the root is NOT touched by any of this: the
 * tag is injected into the *published copies* under `/demo/`, never into
 * `site/*.html`, which `pages.yml` deploys to the root straight from `main`.
 * `ci-workflow-invariants.test.ts` pins that separation in both directions.
 *
 * A `<meta>` rather than the `X-Robots-Tag` HTTP header the request asked for:
 * GitHub Pages serves static files with headers we cannot configure — there is
 * no `_headers`, no `netlify.toml`, no server. The meta tag is the only
 * mechanism available on this host, and search engines treat the two as
 * equivalent for HTML documents. If the site ever moves to a host that can set
 * headers, `X-Robots-Tag: noindex, nofollow` on `/demo/*` replaces this and the
 * tag can go.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `nofollow` rides along deliberately. Without it a crawler that reaches one
 * preview walks every link out of it — including the demo's per-scenario
 * `?scenario=<id>` URLs, which are one crawlable URL per scenario per preview.
 * All of them are noindex, so nothing is indexed either way; this just stops us
 * serving that fan-out on every open PR.
 */
export const NOINDEX_META = '<meta name="robots" content="noindex, nofollow" />'

/** Any existing robots directive, whatever it says. */
const ROBOTS_META = /<meta[^>]+name=["']robots["'][^>]*>/i

/**
 * Add {@link NOINDEX_META} to `html`, returning the document unchanged when it
 * already carries a `noindex` directive so repeated marking is a no-op.
 *
 * Throws when the document has no `</head>` to inject into, or when it already
 * declares a robots directive that is *not* `noindex`: both mean the caller's
 * assumption about this file is wrong, and marking it silently — or quietly
 * fighting a deliberate `index, follow` — is worse than failing the build.
 */
export function withNoindexMeta(html: string): string {
  const existing = ROBOTS_META.exec(html)
  if (existing) {
    if (/noindex/i.test(existing[0])) return html
    throw new Error(`refusing to override an existing robots directive: ${existing[0]}`)
  }
  // At the end of the head, not the start, so the charset declaration keeps its
  // place as the first thing in the document — same spot (and same reason) as
  // the Monaco base injected by `pointHtmlAtMonacoBase`.
  const close = html.search(/<\/head\s*>/i)
  if (close < 0) {
    throw new Error('no </head> to inject the robots meta into')
  }
  // Indent one level inside the closing tag so the published markup reads like
  // the source it was copied from rather than a patched file — unless `</head>`
  // shares its line with other markup, where a line of its own would be the
  // odder result.
  const lineStart = html.lastIndexOf('\n', close) + 1
  const before = html.slice(lineStart, close)
  const insert = /^[ \t]*$/.test(before) ? `  ${NOINDEX_META}\n${before}` : NOINDEX_META
  return `${html.slice(0, close)}${insert}${html.slice(close)}`
}

/** Every `.html` file under `root`, depth-first, sorted for determinism. */
function htmlFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.html')) found.push(path)
    }
  }
  walk(root)
  return found
}

/**
 * Mark every HTML document under `root` noindex, in place. Returns the paths
 * that were rewritten (already-marked files are skipped, so a second pass over
 * the same tree returns nothing and changes no bytes).
 *
 * Byte-stability matters here beyond tidiness: `demo-preview.yml` publishes a
 * target only when the rebuilt bytes differ from what is already on the
 * `demo-previews` branch, so a marker that rewrote the tag differently each run
 * would republish and redeploy the whole site on every push.
 *
 * Throws when `root` holds no HTML at all — that is a mistyped path in a
 * publish step, and the failure it would otherwise cause is a preview quietly
 * shipping indexable.
 */
export function markTreeNoindex(root: string): string[] {
  const files = htmlFiles(root)
  if (files.length === 0) {
    throw new Error(`no HTML under ${root} to mark noindex`)
  }
  const marked: string[] = []
  for (const path of files) {
    const html = readFileSync(path, 'utf8')
    let updated: string
    try {
      updated = withNoindexMeta(html)
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      })
    }
    if (updated === html) continue
    writeFileSync(path, updated)
    marked.push(path)
  }
  return marked
}
