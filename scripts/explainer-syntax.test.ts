import assert from 'node:assert/strict'
import { it } from 'node:test'
import { assertExplainerSyntax, checkBundledExplainerSyntax } from './lib/explainer-syntax.mts'
import { drawingStory, textAlignmentStory } from '../tests/fixtures/explainer-drawing.ts'

const template =
  '<script type="application/json">not JavaScript</script><script>__COPSE_EXPLAINER_DRAWING_RUNTIME__</script>'

it('parses the shipped player, worker and embedded drawing fixtures without running them', () => {
  checkBundledExplainerSyntax([
    { name: 'reservoir drawing', code: drawingStory.drawing.code },
    { name: 'text alignment drawing', code: textAlignmentStory.drawing.code },
  ])
  assertExplainerSyntax(template, 'throw new Error("Do not execute the runtime")', [
    { name: 'inert drawing', code: 'throw new Error("Do not execute the drawing")' },
  ])
})

it('identifies syntax errors hidden inside valid TypeScript string values', () => {
  for (const code of [
    'const = ;',
    'const label = `unfinished;',
    'const x=1; const x=2;',
    'await paint();',
  ]) {
    assert.throws(() => {
      assertExplainerSyntax(template, '', [{ name: 'broken-fixture.drawing.code', code }])
    }, /broken-fixture\.drawing\.code/)
  }
})

it('rejects malformed copied scripts and conflicting declarations across player scripts', () => {
  assert.throws(() => {
    assertExplainerSyntax(template, 'const = ;')
  }, /player\.html/)
  assert.throws(() => {
    assertExplainerSyntax('<script>const shared=1;</script><script>const shared=2;</script>', '')
  }, /player\.html/)
  assert.throws(() => {
    assertExplainerSyntax('<p>No player</p>', '')
  }, /no executable scripts/)
})
