import { createHash } from 'node:crypto'
import ts from 'typescript'
import { SCREENSHOT_NAME } from './screenshot-manifest.mts'
import { AUDITED_NATIVE_OUTPUTS } from './native-screenshot-outputs-audit.mts'

// Filename positions, rather than arbitrary strings inside callbacks/selectors.
const FILENAME_ARGUMENT = new Map([
  ['saveAppScreenshot', 0],
  ['saveAppViewportScreenshot', 0],
  ['saveCanvasPreviewScreenshot', 0],
  ['saveChatPaneScreenshot', 0],
  ['saveClassifierScreenshot', 1],
  ['saveElementScreenshot', 1],
  ['saveHoveredElementScreenshot', 1],
  ['savePortraitElementScreenshot', 1],
  ['savePreparedAppScreenshot', 0],
  ['savePreparedElementScreenshot', 1],
  ['saveScaleComparisonScreenshot', 0],
  ['saveScreenshot', 0],
  ['saveStableCanvasScreenshot', 0],
  ['saveThreePaneScreenshot', 0],
])

function functionName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return null
}

function literalName(expression: ts.Expression): string | null {
  if (!ts.isStringLiteral(expression) && !ts.isNoSubstitutionTemplateLiteral(expression))
    return null
  return SCREENSHOT_NAME.test(expression.text) ? expression.text : null
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : [],
  )
}

function screenshotDirectory(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression) || functionName(expression.expression) !== 'join')
    return false
  const root = expression.arguments[0]
  if (
    !root ||
    !ts.isCallExpression(root) ||
    root.arguments.length !== 0 ||
    !ts.isPropertyAccessExpression(root.expression) ||
    !ts.isIdentifier(root.expression.expression) ||
    root.expression.expression.text !== 'process' ||
    root.expression.name.text !== 'cwd'
  )
    return false
  const parts = expression.arguments.slice(1)
  return (
    parts.length > 0 &&
    parts.every((part) => ts.isStringLiteral(part)) &&
    parts.map((part) => (ts.isStringLiteral(part) ? part.text : '')).join('/') ===
      'tests/e2e/screenshots'
  )
}

/** Exact native outputs; unresolved dynamic producers remain marker controls. */
export function nativeScreenshotOutputs(spec: string, source: string): string[] {
  const tree = ts.createSourceFile(spec, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const aliases = new Map<string, string | null>()
  const directories = new Map<string, boolean>()
  const bind = (name: string, filename: string | null, directory = false): void => {
    aliases.set(name, aliases.has(name) && aliases.get(name) !== filename ? null : filename)
    directories.set(name, (directories.get(name) ?? true) && directory)
  }
  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const constant =
        ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0
      if (ts.isIdentifier(node.name)) {
        bind(
          node.name.text,
          constant && node.initializer && /^[A-Z][A-Z0-9_]*$/.test(node.name.text)
            ? literalName(node.initializer)
            : null,
          constant && node.initializer ? screenshotDirectory(node.initializer) : false,
        )
      } else {
        for (const name of bindingNames(node.name)) bind(name, null)
      }
    } else if (ts.isParameter(node)) {
      for (const name of bindingNames(node.name)) bind(name, null)
    } else if (ts.isImportSpecifier(node)) {
      const declaration = node.parent.parent.parent
      const nativeDirectory =
        (node.propertyName ?? node.name).text === 'E2E_SCREENSHOT_DIR' &&
        ts.isImportDeclaration(declaration) &&
        ts.isStringLiteral(declaration.moduleSpecifier) &&
        declaration.moduleSpecifier.text === './helpers/screenshot.ts'
      bind(node.name.text, null, nativeDirectory)
    }
    ts.forEachChild(node, collectAliases)
  }
  collectAliases(tree)

  const resolveName = (expression: ts.Expression): string | null => {
    if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? null
    return literalName(expression)
  }
  const destinationName = (expression: ts.Expression): string | null => {
    if (!ts.isCallExpression(expression) || functionName(expression.expression) !== 'join')
      return null
    const directory = expression.arguments[0]
    const filename = expression.arguments[1]
    if (
      expression.arguments.length !== 2 ||
      !directory ||
      !ts.isIdentifier(directory) ||
      directories.get(directory.text) !== true ||
      !filename
    )
      return null
    return resolveName(filename)
  }
  const outputs = new Set<string>()
  const captures = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = functionName(node.expression)
      const position = name === null ? undefined : FILENAME_ARGUMENT.get(name)
      const argument = position === undefined ? undefined : node.arguments[position]
      if (argument) {
        const filename =
          name === 'saveScreenshot' ? destinationName(argument) : resolveName(argument)
        if (filename !== null) outputs.add(filename)
      }
    }
    ts.forEachChild(node, captures)
  }
  captures(tree)

  const audited = AUDITED_NATIVE_OUTPUTS[spec]
  if (audited && createHash('sha256').update(source).digest('hex') === audited.sourceSha256) {
    for (const filename of audited.filenames) {
      if (!SCREENSHOT_NAME.test(filename)) throw new Error(`Unsafe audited screenshot: ${filename}`)
      outputs.add(filename)
    }
  }
  return [...outputs].sort()
}
