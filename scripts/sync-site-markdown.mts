/**
 * Markdown twins for the marketing site, generated from the pages themselves.
 *
 * copse.dev ships `index.md`, `architecture.md`, and `privacy.md` beside their
 * `.html` originals, plus an `llms.txt` index, so an agent fetching the site
 * gets the copy without the chrome. Everything under `site/*.md` and
 * `site/llms.txt` is a build artifact: the HTML is the only source of truth.
 *
 *   npm run site:md         regenerate
 *   npm run site:md:check    fail if what is committed isn't what HTML produces
 *
 * `site:md:check` runs inside `npm run check`, and `sync-site-markdown.test.ts`
 * asserts the same thing from the unit suite, so a page edited without a
 * regenerate is caught in CI rather than published as a stale twin.
 *
 * ── Why this can't drift ─────────────────────────────────────────────────────
 * The conversion reads only markup the pages already have to get right for
 * other reasons, so a new section needs no annotation and no second edit:
 *
 *   `<main id="main-content">`   the content root — header/nav/footer are chrome
 *   `aria-hidden="true"`         decorative; already marked so screen readers skip it
 *   `alt=""` / `alt="…"`         decorative image vs. one whose text is content
 *   `hidden`                     inert; already marked so the a11y tree skips it
 *   `data-site-mode`             the one switch the coming-soon CSS block reads
 *   headings, lists, tables      structure the page states outright
 *
 * That is the whole contract. Write a section accessibly — which the site is
 * already reviewed for — and its Markdown is correct with no further work. Get
 * it wrong and the failure is visible in both outputs at once, which is the
 * point: there is no second copy of the words to keep in step.
 *
 * The architecture page is the exception that proves it. Its `<main>` is an
 * empty shell; the content is the `views` data literal its inline script draws
 * from. So this reads that literal (statically — no DOM emulation) and renders
 * the same three things the page does: the component picker, the inspector, and
 * the relationship table. Still one source of truth, still the page's own data.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import Turndown from 'turndown'
import { z } from 'zod'
import { formatGenerated } from './lib/generated-file.mts'

export const SITE_DIR = 'site'
export const SITE_ORIGIN = 'https://copse.dev'

/** Regenerate command, quoted in every "this file is stale" message. */
const SYNC_COMMAND = 'npm run site:md'

/** Elements that never carry page copy, whatever the page. */
const NON_CONTENT_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas']

const turndown = new Turndown({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
})

export type PageMeta = {
  /** File name inside `site/`, e.g. `index.html`. */
  file: string
  title: string
  description: string
  /** Published URL of the Markdown twin. */
  markdownUrl: string
}

// ── HTML → Markdown ──────────────────────────────────────────────────────────

/** `<title>` and `<meta name="description">`, which every page already sets. */
export function readPageMeta(html: string, file: string): PageMeta {
  const { document } = new JSDOM(html).window
  const title = document.querySelector('title')?.textContent.trim() ?? ''
  const description =
    document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ?? ''
  if (title === '') throw new Error(`${file} has no <title>`)
  if (description === '') throw new Error(`${file} has no <meta name="description">`)
  return { file, title, description, markdownUrl: `${SITE_ORIGIN}/${markdownName(file)}` }
}

/** `index.html` → `index.md`. */
export function markdownName(file: string): string {
  return `${basename(file, '.html')}.md`
}

/**
 * Apply the coming-soon switch exactly as the stylesheet does, then drop
 * whatever is left inert. Two rules in `styles.css` carry the whole mode
 * (`.mode-live-only` off, `.mode-coming-soon-only[hidden]` back on), so this
 * mirrors those two and nothing else — going live by deleting the attribute
 * flips this the same way it flips the page.
 */
function applySiteMode(document: Document, root: Element): void {
  if (document.documentElement.getAttribute('data-site-mode') === 'coming-soon') {
    for (const el of root.querySelectorAll('.mode-live-only')) el.remove()
    for (const el of root.querySelectorAll(
      '.mode-coming-soon-only[hidden], .hero-coming-soon[hidden]',
    ))
      el.removeAttribute('hidden')
  }
  // Anything still `hidden` is inert on the published page, in either mode.
  for (const el of root.querySelectorAll('[hidden]')) el.remove()
}

/** Strip everything that is presentation rather than copy. */
function pruneToContent(document: Document, root: Element): void {
  for (const el of root.querySelectorAll(NON_CONTENT_TAGS.join(','))) el.remove()
  for (const el of root.querySelectorAll('[aria-hidden="true"]')) el.remove()
  applySiteMode(document, root)
  // `alt=""` is the author saying "decorative"; honour it rather than guessing.
  for (const img of root.querySelectorAll('img')) {
    if (img.getAttribute('alt')?.trim() === '') img.remove()
  }
  // An image inside a heading contributes its alt text — that IS the heading's
  // accessible name. The hero wordmark is one, and `# ![Copse](…) is an AI …`
  // would be nonsense.
  for (const img of root.querySelectorAll('h1 img, h2 img, h3 img, h4 img, h5 img, h6 img')) {
    img.replaceWith(document.createTextNode(img.getAttribute('alt') ?? ''))
  }
  applyAriaSemantics(document, root)
  rewriteLinks(document, root)
}

/**
 * Honour the semantics ARIA states that the tag names leave out. The provider
 * strip is the case that matters: `role="list"` of `role="listitem"` divs, each
 * naming a provider through `aria-label` because its logo is a decorative
 * image. Read as tags alone it is an empty div; read as ARIA it is the list of
 * everything Copse connects to.
 */
function applyAriaSemantics(document: Document, root: Element): void {
  for (const list of root.querySelectorAll('[role="list"]')) rename(document, list, 'ul')
  for (const item of root.querySelectorAll('[role="listitem"]')) rename(document, item, 'li')
  for (const item of root.querySelectorAll('li')) {
    const label = item.getAttribute('aria-label')?.trim() ?? ''
    if (label !== '' && item.textContent.trim() === '') item.textContent = label
  }
}

/** Re-tag an element in place, keeping its attributes and children. */
function rename(document: Document, el: Element, tagName: string): void {
  const replacement = document.createElement(tagName)
  for (const name of el.getAttributeNames()) {
    replacement.setAttribute(name, el.getAttribute(name) ?? '')
  }
  replacement.append(...el.childNodes)
  el.replaceWith(replacement)
}

/**
 * Point sibling-page links at the Markdown twin, and unwrap in-page anchors —
 * `#download` addresses a section of the HTML page that has no counterpart
 * here, so the link text survives and the dangling target doesn't.
 */
function rewriteLinks(document: Document, root: Element): void {
  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? ''
    if (href.startsWith('#')) {
      anchor.replaceWith(document.createTextNode(anchor.textContent))
      continue
    }
    const [path, fragment] = splitFragment(href)
    if (path.endsWith('.html') && !path.includes('//')) {
      anchor.setAttribute('href', `${markdownName(path)}${fragment}`)
    }
  }
}

function splitFragment(href: string): [string, string] {
  const at = href.indexOf('#')
  return at === -1 ? [href, ''] : [href.slice(0, at), href.slice(at)]
}

/** Collapse the blank-line runs turndown leaves behind after pruning. */
function tidy(markdown: string): string {
  return markdown.replace(/\n{3,}/g, '\n\n').trim()
}

/** Convert one page's `<main>` to Markdown. */
export function pageMarkdown(html: string, file: string): string {
  const { document } = new JSDOM(html).window
  const main = document.querySelector('main')
  if (!main) throw new Error(`${file} has no <main> to convert`)
  pruneToContent(document, main)

  const body = tidy(turndown.turndown(main.innerHTML))
  const diagrams = document.querySelector('.arch-map')
    ? `\n\n${architectureMarkdown(html, file)}`
    : ''
  return `${frontMatter(readPageMeta(html, file), file)}\n\n${body}${diagrams}\n`
}

function frontMatter(meta: PageMeta, file: string): string {
  const canonical = file === 'index.html' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}/${file}`
  return [
    '---',
    `title: ${yamlString(meta.title)}`,
    `description: ${yamlString(meta.description)}`,
    `canonical: ${canonical}`,
    `generated_from: ${SITE_DIR}/${file}`,
    '---',
    '',
    `<!-- Generated from ${SITE_DIR}/${file} by scripts/sync-site-markdown.mts.`,
    `     Do not edit by hand — edit the page and run \`${SYNC_COMMAND}\`. -->`,
  ].join('\n')
}

/** Single-quoted YAML scalar: the one escape is a doubled quote. */
function yamlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

// ── The architecture page's data model ───────────────────────────────────────

const ArchNode = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  sub: z.string(),
  summary: z.string(),
  files: z.array(z.string()),
})

const ArchView = z.object({
  id: z.string(),
  label: z.string(),
  lanes: z.array(z.object({ label: z.string() })),
  nodes: z.array(ArchNode).min(1),
  // [from, to, label] plus an optional `external` flag the diagram styles with.
  edges: z.array(z.tuple([z.string(), z.string(), z.string()]).rest(z.boolean())),
})

const ArchViews = z.array(ArchView).min(1)
const ArchKinds = z.record(z.string(), z.object({ label: z.string() }))

export type ArchView = z.infer<typeof ArchView>
export type ArchKinds = z.infer<typeof ArchKinds>

/**
 * Pull a top-level `const <name> = <literal>` out of source text and evaluate
 * the literal alone, in a context with no globals at all.
 *
 * Running the page under a DOM shim was the alternative and it is the more
 * fragile one: the diagram calls SVG layout APIs (`getComputedTextLength`) that
 * no headless DOM implements, so the render would throw halfway and this would
 * silently emit less. A literal either parses or it doesn't.
 */
export function extractLiteral(source: string, name: string): unknown {
  const declaration = `const ${name} = `
  const start = source.indexOf(declaration)
  if (start === -1) throw new Error(`no \`${declaration.trim()}\` declaration found`)
  const from = start + declaration.length
  const literal = source.slice(from, from + balancedLength(source, from, name))
  // Serialize inside the sandbox so nothing from that realm escapes into this
  // one — the caller gets ordinary JSON values, and anything that isn't data
  // (a function, a reference) drops out here and fails the schema below.
  const json: unknown = runInNewContext(`JSON.stringify(${literal})`, undefined, {
    timeout: 5_000,
  })
  if (typeof json !== 'string') throw new Error(`\`${name}\` is not serializable data`)
  return JSON.parse(json)
}

/** Length of the bracketed literal starting at `from`, skipping strings. */
function balancedLength(source: string, from: number, name: string): number {
  const open = source[from]
  if (open !== '[' && open !== '{') {
    throw new Error(`\`${name}\` is not an array or object literal`)
  }
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let quote = ''
  for (let i = from; i < source.length; i++) {
    const char = source[i]
    if (quote !== '') {
      if (char === '\\') i++
      else if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === open) depth++
    else if (char === close && --depth === 0) return i - from + 1
  }
  throw new Error(`\`${name}\` literal is unterminated`)
}

/** The inline script that holds the diagram data. */
function architectureScript(document: Document, file: string): string {
  for (const script of document.querySelectorAll('script:not([src])')) {
    const source = script.textContent
    if (source.includes('const views = ')) return source
  }
  throw new Error(
    `${file} renders a diagram (.arch-map) but no inline script declares \`const views\`; ` +
      `sync-site-markdown reads that literal for the Markdown twin`,
  )
}

/** Render the diagram data the way the page renders it: picker, inspector, flow. */
export function architectureMarkdown(html: string, file: string): string {
  const { document } = new JSDOM(html).window
  const source = architectureScript(document, file)
  const views = ArchViews.parse(extractLiteral(source, 'views'))
  const kinds = ArchKinds.parse(extractLiteral(source, 'kinds'))
  return views.map((view) => renderView(view, kinds)).join('\n\n')
}

function renderView(view: ArchView, kinds: ArchKinds): string {
  const lanes = view.lanes.map((lane) => lane.label).join(' · ')
  const sections = [`## ${view.label}`]
  if (lanes !== '') sections.push(`Layers: ${lanes}`)
  for (const node of view.nodes) {
    const kind = kinds[node.kind]?.label ?? node.kind
    sections.push(
      `### ${node.title} — ${kind}`,
      `*${node.sub}*`,
      node.summary,
      `Source: ${node.files.map((path) => `\`${path}\``).join(', ')}`,
    )
  }
  if (view.edges.length > 0) {
    const titles = new Map(view.nodes.map((node) => [node.id, node.title]))
    const rows = view.edges.map(([from, to, label]) =>
      row([titles.get(from) ?? from, label, titles.get(to) ?? to]),
    )
    sections.push(
      '### Relationships',
      [row(['From', 'Relationship', 'To']), row(['---', '---', '---']), ...rows].join('\n'),
    )
  }
  return sections.join('\n\n')
}

function row(cells: string[]): string {
  return `| ${cells.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`
}

// ── llms.txt ─────────────────────────────────────────────────────────────────

/**
 * The `llms.txt` convention: a single entry point naming every page and where
 * its Markdown lives. Built from the same `<title>`/`<meta description>` pairs
 * the pages already carry, so a new page joins it by existing.
 */
export function llmsTxt(pages: PageMeta[]): string {
  const home = pages.find((page) => page.file === 'index.html')
  if (!home) throw new Error('site/index.html is missing')
  const lines = ['# Copse', '', `> ${home.description}`, '', '## Pages', '']
  // Home first — a reader following this index wants the front door, not
  // whichever page happens to sort first.
  for (const page of [home, ...pages.filter((page) => page !== home)]) {
    lines.push(`- [${page.title}](${page.markdownUrl}): ${page.description}`)
  }
  return `${lines.join('\n')}\n`
}

// ── Generation ───────────────────────────────────────────────────────────────

export type GeneratedFile = { path: string; content: string }

/** Every page's twin plus the index, rendered but not yet written. */
export async function renderSite(siteDir = SITE_DIR): Promise<GeneratedFile[]> {
  const files = (await readdir(siteDir)).filter((name) => name.endsWith('.html')).sort()
  if (files.length === 0) throw new Error(`no HTML pages found in ${siteDir}`)

  const generated: GeneratedFile[] = []
  const metas: PageMeta[] = []
  for (const file of files) {
    const html = await readFile(join(siteDir, file), 'utf8')
    assertMarkdownLink(html, file)
    metas.push(readPageMeta(html, file))
    generated.push({
      path: join(siteDir, markdownName(file)),
      content: await formatGenerated(join(siteDir, markdownName(file)), pageMarkdown(html, file)),
    })
  }
  generated.push({ path: join(siteDir, 'llms.txt'), content: llmsTxt(metas) })
  return generated
}

/**
 * A page has to advertise its twin, or nothing can find it. Checking here is
 * what keeps that from being a step someone has to remember: add a page, and
 * the first sync tells you the one line it needs.
 */
function assertMarkdownLink(html: string, file: string): void {
  const expected = `<link rel="alternate" type="text/markdown" href="${markdownName(file)}" />`
  if (!html.includes(`href="${markdownName(file)}"`)) {
    throw new Error(`${SITE_DIR}/${file} must link its Markdown twin in <head>:\n  ${expected}`)
  }
}

async function main(): Promise<void> {
  const generated = await renderSite()
  const check = process.argv.includes('--check')

  const stale: string[] = []
  for (const { path, content } of generated) {
    const existing = await readFile(path, 'utf8').catch(() => null)
    if (existing === content) continue
    if (check) stale.push(path)
    else await writeFile(path, content, 'utf8')
  }

  if (!check) {
    console.log(`[sync-site-markdown] ${String(generated.length)} files up to date in ${SITE_DIR}/`)
    return
  }
  if (stale.length > 0) {
    throw new Error(
      `${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} out of date with the HTML; ` +
        `run \`${SYNC_COMMAND}\``,
    )
  }
  console.log(`[sync-site-markdown] ${String(generated.length)} files match ${SITE_DIR}/*.html`)
}

const invokedDirectly = process.argv[1]?.endsWith('sync-site-markdown.mts') === true
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
