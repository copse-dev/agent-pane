// Every first-party plugin description is authored as markdown and rendered in
// Settings → Plugins with `renderMarkdown` (see `settings-dialog.ts`). The
// sanitizer drops anything that parses as an HTML tag, so a bare placeholder
// like `http://localhost:<port>` silently swallows the rest of the copy
// (#3065). Placeholders belong in inline code, where they render literally.
import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '@copse/streaming-markdown'
import { FIRST_PARTY_PLUGINS } from '@copse/agent/plugins/first-party-plugins.ts'

/** Text a reader sees once markdown punctuation is stripped: backticks, bold/italic asterisks and link syntax aside. */
function visibleWords(source: string): string[] {
  return source
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 0)
}

function renderedText(markdown: string): string {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdown(markdown)
  return host.textContent.replace(/\s+/g, ' ')
}

describe('first-party plugin descriptions render without losing text', () => {
  for (const plugin of FIRST_PARTY_PLUGINS) {
    const { description } = plugin.manifest
    if (!description) continue
    it(plugin.id, () => {
      const text = renderedText(description)
      for (const word of visibleWords(description)) {
        assert.ok(text.includes(word), `${plugin.id}: rendered description lost "${word}"`)
      }
    })
  }
})
