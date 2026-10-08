/**
 * Find protocol and implementation jargon in the strings the product can show.
 *
 * Copse's UI is read by people who pick a coding agent and a model, not by
 * people who know which wire protocol the agent speaks. "ACP", "stdio" or
 * "JSON-RPC" in a banner, a tooltip or a settings description explains nothing
 * and invites the reader to go looking for a setting that does not exist (the
 * old "Settings → ACP agents" pointed at no tab at all).
 *
 * The scan is syntactic on purpose. It walks the TypeScript AST and looks only
 * at string literals, template text and nothing else, so comments, identifiers,
 * config keys and import paths — all of which legitimately keep the protocol
 * names — can never trip it. Two further contexts are skipped because their
 * strings are not copy a user reads:
 *
 * - `console.*` arguments: developer logs, not UI.
 * - Property names and element-access keys (`{ acp: … }`, `parsed['error']`):
 *   identifiers wearing quotes.
 *
 * What stays is every string that could be rendered, thrown, or sent to a
 * dialog. Some of that is correctly technical — a CLI for developers, a probe
 * report, an error handed back to the agent rather than the user. Those are
 * listed, with a reason, in `scripts/user-copy-jargon.test.ts`; this module
 * only reports what it finds.
 *
 * Consumed by `scripts/user-copy-jargon.test.ts`.
 */

import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export interface BannedTerm {
  /** Stable name used as the allowlist key and in failure messages. */
  readonly name: string
  readonly pattern: RegExp
}

/**
 * Terms with no meaning to a user. Each pattern is anchored on word boundaries
 * so `acp:` ids inside a longer identifier, or "ipcRenderer", never match; the
 * uppercase-only ones stay case-sensitive so a lowercase `acp` id is left alone.
 */
export const BANNED_TERMS: readonly BannedTerm[] = [
  { name: 'ACP', pattern: /\bACP\b/ },
  { name: 'ASRT', pattern: /\bASRT\b/ },
  { name: 'IPC', pattern: /\bIPC\b/ },
  { name: 'JSON-RPC', pattern: /\bJSON[- ]?RPC\b/i },
  { name: 'stdio', pattern: /\bstdio\b/i },
  { name: 'harness', pattern: /\bharness(?:es)?\b/i },
  { name: 'capability', pattern: /\bcapabilit(?:y|ies)\b/i },
]

export interface CopyHit {
  /** Repo-relative path. */
  readonly file: string
  readonly term: string
  /** 1-based line of the string, for the failure message. */
  readonly line: number
  /** The matching string, whitespace-collapsed and truncated. */
  readonly text: string
}

/**
 * Source that can produce user-visible text: everything tracked under `src/`
 * and `packages/*\/src/` minus tests, e2e specs, demo drivers, and generated
 * files (the plugin catalog is third-party marketplace copy, not ours to edit).
 */
function copySourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', 'src', 'packages'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out
    .split('\n')
    .filter((file) => /\.(ts|mts)$/.test(file) && !file.endsWith('.d.ts'))
    .filter((file) => file.startsWith('src/') || /^packages\/[^/]+\/src\//.test(file))
    .filter((file) => !/\.(test|e2e|demo)\.(ts|mts)$/.test(file))
    .filter((file) => !/\.generated\.(ts|mts)$/.test(file))
    .sort()
}

/** `console.log(...)`, `console.warn(...)` and the like. */
function isConsoleCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'console'
  )
}

/** A string that is an identifier in quotes rather than text anyone reads. */
function isIdentifierPosition(node: ts.Node): boolean {
  const { parent } = node
  return (
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) ||
    ts.isLiteralTypeNode(parent) ||
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent)
  )
}

/** Every copy-bearing string in one file, in source order. */
export function copyStringsIn(
  file: string,
  text: string,
): { readonly line: number; readonly text: string }[] {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: { line: number; text: string }[] = []
  const visit = (node: ts.Node): void => {
    if (isConsoleCall(node)) return
    const isText =
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !isIdentifierPosition(node)
    const isTemplatePart =
      ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    if (isText || isTemplatePart) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      found.push({ line: line + 1, text: node.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/** Banned-term hits across the tracked copy sources, in file then line order. */
export function userCopyHits(): CopyHit[] {
  const hits: CopyHit[] = []
  for (const file of copySourceFiles()) {
    for (const copy of copyStringsIn(file, readFileSync(file, 'utf8'))) {
      for (const term of BANNED_TERMS) {
        if (!term.pattern.test(copy.text)) continue
        hits.push({
          file,
          term: term.name,
          line: copy.line,
          text: copy.text.replace(/\s+/g, ' ').trim().slice(0, 120),
        })
      }
    }
  }
  return hits
}
