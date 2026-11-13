import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import ts from 'typescript'

// Audit every main-process invoke registration, including future modules.
// The newer defineHandler path supplies its sender check at registration.
const BROWSER_DELEGATES = new Set([
  'browser:share-page-text',
  'browser:share-screenshot',
  'browser:capture-screenshot',
  'browser:start-recording',
  'browser:scroll-position',
  'browser:export-pdf',
  'browser:export-page',
])

describe('audited IPC sender checks', () => {
  const files = globSync('src/main/**/*.ts').filter(
    (file) => !file.endsWith('.test.ts') && readFileSync(file, 'utf8').includes('ipcMain.handle('),
  )
  for (const file of files) {
    it(`${file} checks the sender before any invoke handler work`, () => {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      )
      const found = new Set<string>()
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle') {
          const channel = node.arguments[0]
          const callback = node.arguments[1]
          assert.ok(channel, 'expected a channel')
          assert.ok(callback)
          const name = ts.isStringLiteral(channel) ? channel.text : channel.getText(source)
          found.add(name)
          if (file === 'src/main/ipc/define-handler.ts') {
            assert.match(callback.getText(source), /senderCheck\(win, options\)/, name)
          } else if (name === 'skills:set-roots') {
            assert.equal(
              callback.getText(source),
              'createSkillRootsHandler(win, { setSetting, initSkillsRegistry, listSkillSources })',
            )
          } else {
            assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body), name)
            const statement = callback.body.statements[0]
            // A few response handlers catch validation errors and deliberately
            // ignore late replies. Their first statement inside `try` is the gate.
            const first =
              statement && ts.isTryStatement(statement)
                ? (statement.tryBlock.statements[0]?.getText(source) ?? '')
                : (statement?.getText(source) ?? '')
            if (BROWSER_DELEGATES.has(name)) {
              assert.match(first, /interactiveBrowserContents\(event, rawId\)/, name)
            } else if (file === 'src/main/services/clients/client-action-ipc.ts') {
              assert.equal(first, 'assertOwner(event)', name)
            } else {
              assert.equal(first, 'assertMainFrameSender(event, win)', name)
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      if (file === 'src/main/ipc/customization-handlers.ts')
        assert.ok(found.has('skills:set-roots'))
      if (file === 'src/main/index.ts') assert.ok(found.has('lm-studio:models'))
    })
  }

  it('does not opt production domain handlers out of the sender check', () => {
    const source = globSync('src/main/ipc/*.ts')
      .filter(
        (file) =>
          !file.endsWith('.test.ts') &&
          file !== 'src/main/ipc/define-handler.ts' &&
          file !== 'src/main/ipc/ipc-handler.ts',
      )
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    assert.doesNotMatch(source, /sender:\s*['"]any['"]/)
  })

  it('keeps the client action owner check rooted in the main frame', () => {
    const source = readFileSync('src/main/services/clients/client-action-ipc.ts', 'utf8')
    assert.match(source, /const assertOwner = .*?\{\s*assertMainFrameSender\(event, win\)/s)
  })

  it('keeps non-throwing event gates before parsing or reply effects', () => {
    for (const [file, expected, count] of [
      [
        'src/main/services/diagnostics/perf-ipc.ts',
        'if (!isTrustedAppFrame(event.senderFrame)) return',
        1,
      ],
      [
        'src/main/services/plugins/plugin-browser-panel.ts',
        'if (!isWindowMainFrameSender(event, win)) return',
        1,
      ],
      ['src/main/services/video/video-decoder.ts', 'if (!isWindowMainFrameSender(event,', 2],
      ['src/main/ipc/vnc.ts', 'if (!isMainFrameSender(event, win)) return', 2],
    ] as const) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      )
      let checked = 0
      function visit(node: ts.Node): void {
        if (ts.isArrowFunction(node) && ts.isBlock(node.body)) {
          const index = node.body.statements.findIndex((statement) =>
            statement.getText(source).startsWith(expected),
          )
          if (index !== -1) {
            assert.equal(index, 0, `${file}: sender rejection must precede effects`)
            checked += 1
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      assert.equal(checked, count, file)
    }
  })
})
