import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import {
  architectureMarkdown,
  extractLiteral,
  llmsTxt,
  markdownName,
  pageMarkdown,
  readOutDir,
  readPageMeta,
  renderSite,
  type PageMeta,
} from './sync-site-markdown.mts'

/** A minimal page with the two head fields every real page carries. */
function page(body: string, options: { mode?: string } = {}): string {
  const mode = options.mode === undefined ? '' : ` data-site-mode="${options.mode}"`
  return `<!doctype html>
<html lang="en"${mode}>
  <head>
    <title>Test — Copse</title>
    <meta name="description" content="A test page." />
    <link rel="alternate" type="text/markdown" href="test.md" />
  </head>
  <body><main id="main-content">${body}</main></body>
</html>`
}

const convert = (body: string, options?: { mode?: string }): string =>
  pageMarkdown(page(body, options), 'test.html')

describe('pageMarkdown', () => {
  it('keeps the copy and drops the chrome around it', () => {
    const html = `<!doctype html>
<html lang="en"><head><title>T</title><meta name="description" content="D" /></head>
<body>
  <header class="site-header"><nav><a href="index.html">Home</a></nav></header>
  <main id="main-content"><h1>Real copy</h1></main>
  <footer class="site-footer"><p>Footer copy</p></footer>
</body></html>`
    const markdown = pageMarkdown(html, 'test.html')
    assert.match(markdown, /# Real copy/)
    assert.doesNotMatch(markdown, /Footer copy/)
  })

  it('throws rather than guessing when a page has no <main>', () => {
    const html =
      '<html><head><title>T</title><meta name="description" content="D"></head><body><h1>x</h1></body></html>'
    assert.throws(() => pageMarkdown(html, 'test.html'), /no <main>/)
  })

  it('drops decoration the page already marks aria-hidden', () => {
    const markdown = convert('<p>Kept</p><div aria-hidden="true"><p>Decorative</p></div>')
    assert.match(markdown, /Kept/)
    assert.doesNotMatch(markdown, /Decorative/)
  })

  it('honours alt="" as decorative and real alt text as content', () => {
    const markdown = convert(
      '<p><img src="rule.svg" alt="" /><img src="shot.png" alt="A screenshot" /></p>',
    )
    assert.doesNotMatch(markdown, /rule\.svg/)
    assert.match(markdown, /!\[A screenshot\]\(https:\/\/copse\.dev\/shot\.png\)/)
  })

  it('reduces an image inside a heading to its alt text', () => {
    // The hero wordmark: `# ![Copse](brand.svg) is an AI …` would be nonsense,
    // and the alt text is what the heading's accessible name already says.
    const markdown = convert('<h1><img src="brand.svg" alt="Copse" /> is a workspace</h1>')
    assert.match(markdown, /^# Copse is a workspace$/m)
  })

  it('reads ARIA list semantics the tag names leave out', () => {
    const markdown = convert(
      '<div role="list">' +
        '<div role="listitem" aria-label="OpenAI"><img src="openai.png" alt="" /></div>' +
        '<div role="listitem" aria-label="Anthropic"><img src="anthropic.png" alt="" /></div>' +
        '</div>',
    )
    assert.match(markdown, /-\s+OpenAI\n-\s+Anthropic/)
  })

  it('leaves a list item that already has text alone', () => {
    const markdown = convert('<ul><li aria-label="Label">Text</li></ul>')
    assert.match(markdown, /-\s+Text/)
    assert.doesNotMatch(markdown, /Label/)
  })

  it('points sibling pages at their Markdown twin and unwraps in-page anchors', () => {
    const markdown = convert(
      '<p><a href="privacy.html">Privacy</a> <a href="#download">Download</a> ' +
        '<a href="https://example.com/a.html">External</a></p>',
    )
    assert.match(markdown, /\[Privacy\]\(https:\/\/copse\.dev\/privacy\.md\)/)
    assert.match(markdown, /\[External\]\(https:\/\/example\.com\/a\.html\)/)
    // The anchor has no counterpart in Markdown; the words survive, the link doesn't.
    assert.match(markdown, /Download/)
    assert.doesNotMatch(markdown, /\(#download\)/)
  })

  it('keeps a fragment when rewriting a sibling page link', () => {
    const markdown = convert('<p><a href="index.html#download">Get it</a></p>')
    assert.match(markdown, /\[Get it\]\(https:\/\/copse\.dev\/index\.md#download\)/)
  })

  it('publishes absolute URLs, because a fetched twin gets copied away from its origin', () => {
    const markdown = convert(
      '<p><img src="screenshots/x.png" alt="A shot" />' +
        '<a href="demo/main/?scenario=landing">Demo</a> <a href="/releases">Releases</a> ' +
        '<a href="mailto:hi@copse.dev">Mail</a> <a href="//cdn.example.com/x">CDN</a></p>',
    )
    assert.match(markdown, /!\[A shot\]\(https:\/\/copse\.dev\/screenshots\/x\.png\)/)
    assert.match(markdown, /\[Demo\]\(https:\/\/copse\.dev\/demo\/main\/\?scenario=landing\)/)
    // A root-relative path names the same file as a page-relative one here, so
    // it must not come out with a doubled slash.
    assert.match(markdown, /\[Releases\]\(https:\/\/copse\.dev\/releases\)/)
    // Anything that already names an origin is left alone.
    assert.match(markdown, /\[Mail\]\(mailto:hi@copse\.dev\)/)
    assert.match(markdown, /\[CDN\]\(\/\/cdn\.example\.com\/x\)/)
  })

  describe('coming-soon mode', () => {
    const BODY =
      '<p class="mode-live-only">Download now</p>' +
      '<p class="mode-coming-soon-only" hidden>Coming soon</p>' +
      '<p hidden>Inert either way</p>'

    it('publishes what the stylesheet publishes', () => {
      const markdown = convert(BODY, { mode: 'coming-soon' })
      assert.match(markdown, /Coming soon/)
      assert.doesNotMatch(markdown, /Download now/)
      assert.doesNotMatch(markdown, /Inert either way/)
    })

    it('follows the page to live when the attribute goes', () => {
      // Deleting `data-site-mode` is half of going live; the twin flips with it,
      // with nothing else to remember.
      const markdown = convert(BODY)
      assert.match(markdown, /Download now/)
      assert.doesNotMatch(markdown, /Coming soon/)
      assert.doesNotMatch(markdown, /Inert either way/)
    })
  })

  it('carries the page metadata as front matter', () => {
    const markdown = convert('<h1>Hi</h1>')
    assert.match(markdown, /^---\ntitle: 'Test — Copse'\n/)
    assert.match(markdown, /^description: 'A test page\.'$/m)
    assert.match(markdown, /^generated_from: site\/test\.html$/m)
  })

  it('ships no repo housekeeping to the reader', () => {
    // The twins are generated at deploy and never committed, so a "do not edit
    // by hand" banner would be addressed to a reader who does not exist — while
    // every agent fetching the page pays for it. `generated_from` above already
    // says the same thing in a line a machine can read.
    assert.doesNotMatch(convert('<h1>Hi</h1>'), /<!--/)
  })
})

describe('readPageMeta', () => {
  it('fails loudly on a page missing the fields llms.txt needs', () => {
    assert.throws(
      () => readPageMeta('<html><head><title>T</title></head><body></body></html>', 'x.html'),
      /no <meta name="description">/,
    )
    assert.throws(
      () => readPageMeta('<html><head></head><body></body></html>', 'x.html'),
      /no <title>/,
    )
  })
})

describe('extractLiteral', () => {
  it('reads a nested literal without executing the code around it', () => {
    const source = `
      window.boom = 1
      const views = [{ id: 'a', nodes: [{ files: ['x.ts'] }] }]
      const after = 2
    `
    assert.deepEqual(extractLiteral(source, 'views'), [{ id: 'a', nodes: [{ files: ['x.ts'] }] }])
  })

  it('is not confused by brackets inside strings', () => {
    const source = `const kinds = { a: { label: 'a ] b } c' }, b: { label: "]" } }`
    assert.deepEqual(extractLiteral(source, 'kinds'), {
      a: { label: 'a ] b } c' },
      b: { label: ']' },
    })
  })

  it('has no globals to reach for', () => {
    assert.throws(() => extractLiteral('const views = [process.pid]', 'views'), /process/)
  })

  it('reports a renamed or missing declaration instead of emitting less', () => {
    assert.throws(() => extractLiteral('const other = []', 'views'), /no `const views =`/)
    assert.throws(() => extractLiteral('const views = fn()', 'views'), /not an array or object/)
    assert.throws(() => extractLiteral('const views = [1, 2', 'views'), /unterminated/)
  })
})

describe('architectureMarkdown', () => {
  const ARCH = `<!doctype html>
<html><head><title>A</title><meta name="description" content="D" /></head>
<body><main id="main-content"><div class="arch-map"></div></main>
<script>
  const kinds = { runtime: { label: 'Runtime' } }
  const views = [
    {
      id: 'overview',
      label: 'Overview',
      height: 10,
      lanes: [{ y: 1, label: 'Desktop runtime' }],
      nodes: [
        { id: 'main', x: 1, y: 1, w: 1, h: 1, kind: 'runtime', title: 'Main process',
          sub: 'trusted host', summary: 'Owns startup.', files: ['src/main/index.ts'] },
        { id: 'agent', x: 1, y: 1, w: 1, h: 1, kind: 'runtime', title: 'Agent | service',
          sub: 'orchestrate', summary: 'Runs the turn.', files: ['src/main/agent.ts'] },
      ],
      edges: [['main', 'agent', 'agent:run'], ['agent', 'main', 'chunks', true]],
    },
  ]
</script></body></html>`

  it('renders the data the diagram draws from', () => {
    const markdown = architectureMarkdown(ARCH, 'architecture.html')
    assert.match(markdown, /^## Overview$/m)
    assert.match(markdown, /Layers: Desktop runtime/)
    assert.match(markdown, /^### Main process — Runtime$/m)
    assert.match(markdown, /Owns startup\./)
    assert.match(markdown, /Source: `src\/main\/index\.ts`/)
  })

  it('renders the relationship table the page renders, with node titles', () => {
    const markdown = architectureMarkdown(ARCH, 'architecture.html')
    assert.match(markdown, /\| From \| Relationship \| To \|/)
    assert.match(markdown, /\| Main process \| agent:run \| Agent \\\| service \|/)
  })

  it('is reached through the page, not a file name', () => {
    // `.arch-map` in the markup is what says "this page has a diagram", so a
    // second diagram page needs no registration here.
    const markdown = pageMarkdown(ARCH, 'architecture.html')
    assert.match(markdown, /^## Overview$/m)
  })

  it('refuses to publish a diagram page it cannot read', () => {
    const renamed = ARCH.replace('const views = ', 'const diagrams = ')
    assert.throws(() => pageMarkdown(renamed, 'architecture.html'), /no inline script declares/)
  })
})

describe('llmsTxt', () => {
  const meta = (file: string, title: string): PageMeta => ({
    file,
    title,
    description: `About ${title}.`,
    markdownUrl: `https://copse.dev/${markdownName(file)}`,
  })

  it('indexes every page from the metadata the pages already carry', () => {
    const txt = llmsTxt([meta('index.html', 'Home'), meta('privacy.html', 'Privacy')])
    assert.match(txt, /^# Copse$/m)
    assert.match(txt, /^> About Home\.$/m)
    assert.match(txt, /^- \[Home\]\(https:\/\/copse\.dev\/index\.md\): About Home\.$/m)
    assert.match(txt, /^- \[Privacy\]\(https:\/\/copse\.dev\/privacy\.md\): About Privacy\.$/m)
  })

  it('lists the home page first, whatever order the pages arrive in', () => {
    const txt = llmsTxt([meta('architecture.html', 'Architecture'), meta('index.html', 'Home')])
    assert.match(txt, /- \[Home\][^\n]*\n- \[Architecture\]/)
  })

  it('needs a home page to describe the site', () => {
    assert.throws(() => llmsTxt([meta('privacy.html', 'Privacy')]), /index\.html is missing/)
  })
})

describe('readOutDir', () => {
  it('reads the destination in either spelling, defaulting beside the pages', () => {
    assert.equal(readOutDir([]), 'site')
    assert.equal(readOutDir(['--out', '_site']), '_site')
    assert.equal(readOutDir(['--out=_site']), '_site')
  })

  it('refuses a missing directory rather than writing somewhere surprising', () => {
    assert.throws(() => readOutDir(['--out']), /--out needs a directory/)
    assert.throws(() => readOutDir(['--out', '--verbose']), /--out needs a directory/)
  })
})

describe('the published site', () => {
  it('generates cleanly from the real pages', async () => {
    // Nothing here is committed, so there is no drift to check — pages.yml
    // regenerates the twins into the deployed tree on every publish. This is
    // what replaces that gate: the deploy runs exactly this code with no review
    // between it and the live site, so a page that loses its `<main>`, its
    // `<title>`, its `<link rel="alternate">`, or (on architecture.html) its
    // `views` literal has to fail on the PR that does it.
    const generated = await renderSite()
    const pages = (await readdir('site')).filter((name) => name.endsWith('.html')).sort()

    assert.deepEqual(
      generated.map(({ path }) => path),
      [...pages.map((page) => join('site', markdownName(page))), join('site', 'llms.txt')],
    )
    for (const { path, content } of generated) {
      assert.ok(content.trim() !== '', `${path} generated empty`)
    }
  })

  it('renders into a build tree without writing beside the pages', async () => {
    // How the deploy calls it. The pages are still read from site/; only the
    // output moves, into the tree that is about to be uploaded to Pages.
    const generated = await renderSite('site', '_site')
    assert.ok(
      generated.every(({ path }) => path.startsWith(`_site${sep}`)),
      generated.map(({ path }) => path).join(', '),
    )
  })
})
