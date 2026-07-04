import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { escapeHtml } from './escape.ts'

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('json', json)
hljs.registerLanguage('python', python)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('go', go)
hljs.registerLanguage('sql', sql)

/** Map common fence info strings to highlight.js language ids. */
const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  zsh: 'bash',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  html: 'xml',
  htm: 'xml',
  rs: 'rust',
  text: 'plaintext',
  plaintext: 'plaintext',
}

function resolveLanguage(lang: string): string | null {
  const key = lang.trim().toLowerCase()
  if (!key) return null
  const resolved = LANG_ALIASES[key] ?? key
  if (resolved === 'plaintext') return null
  return hljs.getLanguage(resolved) ? resolved : null
}

/**
 * Highlight fenced code for HTML injection; falls back to escaped plain text.
 * The code is rendered verbatim — leading/trailing blank lines and the first
 * line's indentation are preserved (#598); only the block-final newline is
 * dropped for display (the fence parser already omits it).
 */
export function highlightFenceCode(code: string, lang: string): string {
  if (code === '') return ''
  // Blank-only fences (only newlines/spaces) are preserved exactly rather than
  // fed to the highlighter, which would otherwise collapse or mis-detect them.
  if (code.trim() === '') return escapeHtml(code)

  const language = resolveLanguage(lang)
  if (language) {
    return hljs.highlight(code, { language }).value
  }

  if (!lang.trim()) {
    const { value } = hljs.highlightAuto(code)
    return value
  }

  return escapeHtml(code)
}

export function fenceCodeClass(lang: string): string {
  const language = resolveLanguage(lang)
  const label = language ?? (lang.trim() ? lang.trim().toLowerCase() : 'text')
  return `hljs lang-${label}`
}

/**
 * Undo app-specific fenced-code decoration for CommonMark conformance
 * comparison (the code analogue of `stripAppLinkAttributes`): drop
 * highlight.js token spans, map `hljs lang-x` to the spec's `language-x`
 * (dropping the class entirely for the empty-info `lang-text` fallback), and
 * restore the block-final newline the app trims for display. Structural
 * differences in the code text itself still register as failures.
 */
export function stripAppCodeDecorations(html: string): string {
  return html.replace(
    /<code class="hljs lang-([^"]*)">([\s\S]*?)<\/code>/g,
    (_m, lang: string, body: string) => {
      const text = body.replace(/<span[^>]*>|<\/span>/g, '')
      const classAttr = lang === 'text' ? '' : ` class="language-${lang}"`
      const content = text === '' || text.endsWith('\n') ? text : `${text}\n`
      return `<code${classAttr}>${content}</code>`
    },
  )
}
