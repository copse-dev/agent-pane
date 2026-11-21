import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderMarkdown } from '@copse/streaming-markdown'
import {
  paintAssistantMarkdown,
  paintUserMarkdown,
  renderSettledMessageMarkdown,
  renderUserPromptMarkdown,
  userPromptMarkdown,
} from './message-markdown.ts'

test('a settled reply gets every shared enhancement plus the host decoration', () => {
  const el = document.createElement('div')
  el.classList.add('is-streaming')
  const decorated: HTMLElement[] = []
  renderSettledMessageMarkdown(
    el,
    '```mermaid\ngraph TD; A-->B\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```sh\npnpm test\n```',
    { decorate: (target) => decorated.push(target), runCommands: true },
  )
  assert.equal(el.classList.contains('is-streaming'), false)
  assert.deepEqual(decorated, [el])
  // No isolated frame in this DOM: the pass falls back to the inert source.
  assert.ok(el.querySelector('.mermaid-diagram[data-mermaid-ui] .mermaid-fallback-source'))
  assert.ok(el.querySelector('.table-copy'))
  assert.ok(el.querySelector('.code-block-copy'))
  assert.ok(el.querySelector('.code-block-run'))
})

test('without runCommands a shell block is copy-only', () => {
  const el = document.createElement('div')
  paintAssistantMarkdown(el, '```sh\npnpm test\n```', false)
  assert.ok(el.querySelector('.code-block-copy'))
  assert.equal(el.querySelector('.code-block-run'), null)
})

test('render options reach the parser (a surface’s sanitizer and footnote ids)', () => {
  const el = document.createElement('div')
  renderSettledMessageMarkdown(el, 'Note[^1]\n\n[^1]: Detail', {
    renderOptions: { footnoteIdPrefix: 'surface-' },
  })
  assert.ok(el.querySelector('[id^="surface-"]'))
})

test('user prompts keep markup literal and composer newlines as hard breaks', () => {
  assert.equal(userPromptMarkdown('a\nb'), 'a  \nb')
  assert.equal(userPromptMarkdown('```\na\nb\n```'), '```\na\nb\n```')
  const el = document.createElement('div')
  paintUserMarkdown(el, '<img src=x>\nnext')
  assert.equal(el.querySelector('img'), null)
  assert.ok(el.querySelector('br'))
  assert.match(el.textContent, /<img src=x>/)
})

test('a long prompt folds; a short one does not', () => {
  const short = document.createElement('div')
  renderUserPromptMarkdown(short, 'one line')
  assert.equal(short.classList.contains('msg-user-fold'), false)
  const long = document.createElement('div')
  renderUserPromptMarkdown(
    long,
    Array.from({ length: 30 }, (_, i) => `line ${String(i)}`).join('\n'),
  )
  assert.ok(long.classList.contains('msg-user-fold'))
})

for (const fence of ['```', '````', '~~~', '~~~~']) {
  test(`folded ${fence} code keeps its whole-source context and exact payload`, () => {
    const payload = [
      '  first\tvalue',
      ...Array.from({ length: 12 }, (_, i) => `line ${String(i)}  `),
      '`` not a closing fence',
      '~~~ not a closing fence',
      '<img src=x onerror=alert(1)>',
    ].join('\n')
    const source = `Please review:\n${fence}text\n${payload}\n${fence}`
    const el = document.createElement('div')
    renderUserPromptMarkdown(el, source)
    assert.ok(el.classList.contains('msg-user-fold'))
    assert.equal(el.querySelector('.msg-user-fold-tail pre') === null, true)
    assert.equal(el.querySelector('.msg-user-fold-tail')?.textContent, '')
    assert.equal(el.querySelector('img') === null, true)
    const full = document.createElement('div')
    full.innerHTML = renderMarkdown(source, { htmlPolicy: 'escape-all' })
    assert.equal(
      [...el.querySelectorAll('pre code')].map((code) => code.textContent).join(''),
      full.querySelector('pre code')?.textContent,
    )
    const toggle = el.querySelector<HTMLButtonElement>('button.msg-user-fold-toggle')
    assert.ok(toggle)
    toggle.click()
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(el.querySelectorAll('pre code').length, 1)
    toggle.click()
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  })
}

test('a fence split after its first code line retains that newline exactly once', () => {
  const payload = Array.from({ length: 15 }, (_, i) => `  item ${String(i)}\t `).join('\n')
  const el = document.createElement('div')
  renderUserPromptMarkdown(el, `\`\`\`text\n${payload}\n\`\`\`\nWhat should change?`)
  assert.equal(el.querySelector('.msg-user-fold-tail')?.textContent, 'What should change?')
  assert.equal(
    [...el.querySelectorAll('pre code')].map((code) => code.textContent).join(''),
    `${payload}\n`,
  )
  assert.equal(el.querySelectorAll('pre code').length, 2)
})

test('genuine empty code and shorter literal delimiters survive folding', () => {
  const el = document.createElement('div')
  const payload = ['```', ...Array.from({ length: 12 }, (_, i) => `item ${String(i)}`)].join('\n')
  renderUserPromptMarkdown(el, `\`\`\`\n\`\`\`\n\`\`\`\`text\n${payload}\n\`\`\`\``)
  const codes = [...el.querySelectorAll('pre code')]
  assert.equal(codes.length, 2)
  assert.equal(codes[0]?.textContent, '')
  assert.equal(codes[1]?.textContent, `${payload}\n`)
  assert.equal(el.querySelector('.msg-user-fold-tail pre') === null, true)
})

test('an unclosed fence keeps a shorter authored closing-looking line as code', () => {
  const payload = [...Array.from({ length: 13 }, (_, i) => `item ${String(i)}`), '```'].join('\n')
  const el = document.createElement('div')
  renderUserPromptMarkdown(el, `\`\`\`\`text\n${payload}`)
  assert.equal(
    [...el.querySelectorAll('pre code')].map((code) => code.textContent).join(''),
    `${payload}\n`,
  )
  assert.equal(el.querySelector('.msg-user-fold-tail code')?.textContent, '```\n')
})

test('an authored empty block crossing a cut remains present exactly once', () => {
  const el = document.createElement('div')
  renderUserPromptMarkdown(
    el,
    [
      'Opening note',
      '```',
      '```',
      ...Array.from({ length: 12 }, () => 'More detail'),
      'Final ask',
    ].join('\n'),
  )
  assert.equal(el.querySelectorAll('pre code').length, 1)
  assert.equal(el.querySelector('pre code')?.textContent, '')
  assert.equal(el.querySelector('.msg-user-fold-tail')?.textContent, 'Final ask')
})

test('indented and longer closing fences preserve code indentation at both cuts', () => {
  const body = Array.from({ length: 12 }, (_, i) => `   \tvalue ${String(i)}  `).join('\r\n')
  const source = `   ~~~~text\r\n${body}\r\n  ~~~~~~\t\r\nFinal ask\r\n`
  const full = document.createElement('div')
  full.innerHTML = renderMarkdown(source, { htmlPolicy: 'escape-all' })
  const el = document.createElement('div')
  renderUserPromptMarkdown(el, source)
  assert.equal(
    [...el.querySelectorAll('pre code')].map((code) => code.textContent).join(''),
    full.querySelector('pre code')?.textContent,
  )
  assert.equal(el.querySelector('.msg-user-fold-tail')?.textContent.trim(), 'Final ask')
})

for (const spanning of [false, true]) {
  test(`reference definitions around a contained fence keep their region context (spanning=${String(spanning)})`, () => {
    const opening = spanning ? '```text\nfirst\nsecond\n```\n' : 'Opening note\nSecond note\n'
    const source = `${opening}See [docs][guide].\n\n\`\`\`text\n${Array.from({ length: 12 }, () => 'example').join('\n')}\n\`\`\`\n\n[guide]: https://example.com/docs\nFinal ask`
    const el = document.createElement('div')
    renderUserPromptMarkdown(el, source)
    assert.equal(el.querySelector('a')?.getAttribute('href'), 'https://example.com/docs')
    assert.equal(el.querySelector('a')?.textContent, 'docs')
  })
}

test('a contained list fence keeps its original closer and following prose', () => {
  const source = [
    '```text',
    'first',
    ...Array.from({ length: 8 }, () => 'second'),
    '```',
    '',
    '- item',
    '  ```text',
    '  literal',
    '  ```',
    '  after item',
    '',
    'Outside paragraph',
    'Final ask',
  ].join('\n')
  const el = document.createElement('div')
  renderUserPromptMarkdown(el, source)
  assert.equal(el.querySelector('.msg-user-fold-middle ul pre code')?.textContent, 'literal\n')
  assert.match(el.querySelector('ul')?.textContent ?? '', /after item/)
  assert.equal(
    [...el.querySelectorAll('.msg-user-fold-middle > p')].some((p) =>
      p.textContent.includes('Outside paragraph'),
    ),
    true,
  )
  assert.equal(el.querySelector('.msg-user-fold-tail')?.textContent, 'Final ask')
})

test('unsupported container openers do not turn their closer into a new root fence', () => {
  const source = [
    '- ```text',
    '  first',
    '  second',
    '  ```',
    ...Array.from({ length: 12 }, () => 'Plain detail'),
    'Final ask',
  ].join('\n')
  const el = document.createElement('div')
  renderUserPromptMarkdown(el, source)
  assert.equal(el.querySelector('.msg-user-fold-tail pre') === null, true)
  assert.equal(el.querySelector('.msg-user-fold-tail')?.textContent, 'Final ask')
})

test('container-looking literal code does not disable standalone fence context', () => {
  const payload = ['- ```text', '> ~~~', ...Array.from({ length: 12 }, () => 'literal')].join('\n')
  const el = document.createElement('div')
  renderUserPromptMarkdown(el, `Opening note\n\`\`\`\`text\n${payload}\n\`\`\`\``)
  assert.equal(el.querySelector('.msg-user-fold-tail pre') === null, true)
  assert.equal(
    [...el.querySelectorAll('pre code')].map((code) => code.textContent).join(''),
    `${payload}\n`,
  )
})

for (const list of [
  { marker: '- item', indent: '  ' },
  { marker: '1. item', indent: '   ' },
]) {
  for (const fence of ['```', '~~~']) {
    for (const cut of ['head', 'tail']) {
      test(`a ${list.marker} continuation ${fence} crossing the ${cut} cut keeps its whole container`, () => {
        const payload = Array.from({ length: 12 }, (_, i) => `line ${String(i)}  `).join('\n')
        const source = [
          ...(cut === 'tail' ? ['Opening note', 'Second note'] : []),
          list.marker,
          `${list.indent}${fence}text`,
          ...payload.split('\n').map((line) => `${list.indent}${line}`),
          `${list.indent}${fence}`,
          ...(cut === 'head' ? [`${list.indent}after item`, '', 'Final ask'] : []),
        ].join('\n')
        const full = document.createElement('div')
        full.innerHTML = renderMarkdown(source, { htmlPolicy: 'escape-all' })
        const el = document.createElement('div')
        renderUserPromptMarkdown(el, source)
        assert.equal(el.classList.contains('msg-user-fold'), false)
        assert.equal(el.querySelector('.msg-user-fold-toggle'), null)
        assert.equal(el.querySelectorAll('pre code').length, 1)
        assert.equal(el.querySelector('li pre code')?.textContent, `${payload}\n`)
        assert.equal(
          el.querySelector('li pre code')?.textContent,
          full.querySelector('li pre code')?.textContent,
        )
        if (cut === 'head') {
          assert.match(el.querySelector('li')?.textContent ?? '', /after item/)
          const ask = [...el.querySelectorAll('p')].find((p) => p.textContent === 'Final ask')
          const fullAsk = [...full.querySelectorAll('p')].find((p) => p.textContent === 'Final ask')
          assert.ok(ask)
          assert.ok(fullAsk)
          // Match the parser's whole-document container, including ordered
          // continuations whose final paragraph remains in the list item.
          if (fullAsk.parentElement === full) assert.equal(ask.parentElement, el)
          else assert.equal(ask.closest('li'), el.querySelector('li'))
        }
      })
    }
  }
}

for (const indent of [' ', '  ', '   ']) {
  for (const fence of ['```', '~~~']) {
    test(`a standalone ${String(indent.length)}-space ${fence} fence still folds with exact code`, () => {
      const payload = Array.from({ length: 12 }, (_, i) => `${indent}line ${String(i)}  `).join(
        '\n',
      )
      const source = `Opening note\n${indent}${fence}text\n${payload}\n${indent}${fence}`
      const full = document.createElement('div')
      full.innerHTML = renderMarkdown(source, { htmlPolicy: 'escape-all' })
      const el = document.createElement('div')
      renderUserPromptMarkdown(el, source)
      assert.equal(el.classList.contains('msg-user-fold'), true)
      assert.equal(
        [...el.querySelectorAll('pre code')].map((code) => code.textContent).join(''),
        full.querySelector('pre code')?.textContent,
      )
      assert.equal(el.querySelector('.msg-user-fold-tail pre'), null)
    })
  }
}

test('an indented root fence after a finished list still folds', () => {
  const payload = Array.from({ length: 12 }, (_, i) => `  line ${String(i)}`).join('\n')
  const source = `- item\n\nOutside paragraph\n\n  ~~~text\n${payload}\n  ~~~`
  const el = document.createElement('div')
  renderUserPromptMarkdown(el, source)
  assert.equal(el.classList.contains('msg-user-fold'), true)
  assert.equal(el.querySelector('.msg-user-fold-tail pre'), null)
  assert.equal(el.querySelector('li')?.textContent, 'item')
})

test('a whole container replaces a previously painted accordion', () => {
  const el = document.createElement('div')
  renderUserPromptMarkdown(el, Array.from({ length: 15 }, () => 'detail').join('\n'))
  assert.equal(el.classList.contains('msg-user-fold'), true)
  const payload = Array.from({ length: 12 }, () => '  code').join('\n')
  renderUserPromptMarkdown(el, `- item\n  ~~~text\n${payload}\n  ~~~\nFinal ask`)
  assert.equal(el.classList.contains('msg-user-fold'), false)
  assert.equal(el.querySelector('.msg-user-fold-toggle'), null)
  assert.equal(el.querySelector('li pre code')?.textContent, 'code\n'.repeat(12))
})

for (const indent of [' ', '  ', '   ']) {
  for (const fence of ['```', '~~~']) {
    test(`a referenced footnote before a ${String(indent.length)}-space ${fence} root fence keeps folding`, () => {
      const payload = Array.from({ length: 12 }, (_, i) => `${indent}line ${String(i)}  `).join(
        '\n',
      )
      const source = `Earlier note[^1]\n\n[^1]: Detail\n\n${indent}${fence}text\n${payload}\n${indent}${fence}`
      const full = document.createElement('div')
      full.innerHTML = renderMarkdown(source, { htmlPolicy: 'escape-all' })
      const el = document.createElement('div')
      renderUserPromptMarkdown(el, source)
      assert.equal(el.classList.contains('msg-user-fold'), true)
      assert.ok(el.querySelector('.msg-user-fold-toggle'))
      assert.equal(
        [...el.querySelectorAll('pre code')].map((code) => code.textContent).join(''),
        full.querySelector('pre code')?.textContent,
      )
      assert.equal(el.querySelector('.msg-user-fold-tail pre'), null)
    })
  }
}

test('a prior literal probe string cannot make a nested continuation look root-level', () => {
  const payload = Array.from({ length: 12 }, (_, i) => `line ${String(i)}  `).join('\n')
  const source = [
    '```text',
    'copse-fold-context-probe',
    '```',
    '',
    '- item',
    '  ~~~text',
    ...payload.split('\n').map((line) => `  ${line}`),
    '  ~~~',
  ].join('\n')
  const full = document.createElement('div')
  full.innerHTML = renderMarkdown(source, { htmlPolicy: 'escape-all' })
  const el = document.createElement('div')
  renderUserPromptMarkdown(el, source)
  assert.equal(el.classList.contains('msg-user-fold'), false)
  assert.equal(el.querySelector('.msg-user-fold-toggle'), null)
  assert.equal(el.querySelector('li pre code')?.textContent, `${payload}\n`)
  assert.deepEqual(
    [...el.querySelectorAll('pre code')].map((code) => code.textContent),
    [...full.querySelectorAll('pre code')].map((code) => code.textContent),
  )
})
