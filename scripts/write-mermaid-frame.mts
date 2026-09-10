import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Opaque file frames cannot fetch local scripts. Embed exactly one hash-pinned
 * bootstrap instead; no script URL or arbitrary inline code is permitted. */
export function writeMermaidFrameHtml(outputDir: string): void {
  const script = readFileSync(join(outputDir, 'mermaid-frame.js'), 'utf8')
  // esbuild escapes inline-script closing tags. Fail closed if that ever changes.
  if (/<\/script/i.test(script))
    throw new Error('Unsafe inline-script terminator in Mermaid bundle')
  const hash = createHash('sha256').update(script).digest('base64')
  const template = readFileSync('src/renderer/mermaid-frame.html', 'utf8')
  const html = template
    .replace('__MERMAID_SCRIPT_HASH__', hash)
    .replace(/<script>\s*__MERMAID_BOOTSTRAP__\s*<\/script>/, () => `<script>${script}</script>`)
  writeFileSync(join(outputDir, 'mermaid-frame.html'), html)
}
