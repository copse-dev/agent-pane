import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatDesignNotes,
  formatDesignSource,
  type DesignPickedElement,
} from './browser-design-mode.ts'

function element(overrides: Partial<DesignPickedElement> = {}): DesignPickedElement {
  return {
    pickId: 1,
    url: 'https://app.test/pricing',
    title: 'Pricing',
    tag: 'button',
    selector: 'main > button.cta',
    text: 'Start trial',
    html: '<button class="cta">Start trial</button>',
    htmlOmittedChars: 0,
    rect: { x: 10.4, y: 20.6, width: 120, height: 40 },
    viewport: { width: 800, height: 600 },
    styles: { color: 'rgb(0, 0, 0)', 'font-size': '14px' },
    source: { via: 'react', file: 'src/Hero.tsx', line: 42, column: 7, component: 'Hero' },
    screenshot: 'data:image/png;base64,AAA',
    ...overrides,
  }
}

describe('design notes', () => {
  it('formats a source location with whatever precision the page gave', () => {
    const source = { via: 'vue', file: 'src/Card.vue', line: null, column: null, component: null }
    assert.equal(formatDesignSource(source), 'src/Card.vue')
    assert.equal(formatDesignSource({ ...source, line: 3 }), 'src/Card.vue:3')
    assert.equal(formatDesignSource({ ...source, line: 3, column: 9 }), 'src/Card.vue:3:9')
  })

  it('numbers each element, its note and its attached screenshot', () => {
    const text = formatDesignNotes([
      { element: element(), note: '  Make this pink ' },
      {
        element: element({ pickId: 2, selector: 'h1', screenshot: null, source: null }),
        note: '',
      },
      { element: element({ pickId: 3, selector: 'footer' }), note: 'Less padding' },
    ])
    assert.match(text, /^Design notes on 3 elements of Pricing \(https:\/\/app\.test\/pricing\)\./)
    assert.match(text, /untrusted page content/)
    assert.match(text, /## 1\. `main > button\.cta`\n\nRequest: Make this pink\n/)
    assert.match(text, /Source: src\/Hero\.tsx:42:7 \(Hero\) via react/)
    assert.match(text, /Size: 120×40 at \(10, 21\) in a 800×600 viewport/)
    assert.match(
      text,
      /## 2\. `h1`\n\nRequest: \(no note; see the other elements\)\nSource: not exposed by the page/,
    )
    // Image numbers skip the element that had no crop.
    assert.match(text, /## 3\. `footer`[\s\S]*Screenshot: attached image 2/)
    assert.match(text, /```css\ncolor: rgb\(0, 0, 0\);\nfont-size: 14px;\n```/)
  })

  it('names the page per element when they come from different pages', () => {
    const text = formatDesignNotes([
      { element: element(), note: 'a' },
      { element: element({ url: 'https://app.test/about' }), note: 'b' },
    ])
    assert.match(text, /^Design notes on 2 elements\.\n/)
    assert.match(text, /Page: https:\/\/app\.test\/about/)
  })

  it('keeps page markup inside its fence and reports truncation', () => {
    const text = formatDesignNotes([
      { element: element({ html: '<pre>```js</pre>', htmlOmittedChars: 1234 }), note: '' },
    ])
    assert.match(text, /````html\n<pre>```js<\/pre>\n<!-- 1,234 more characters omitted -->\n````/)
  })

  it('returns nothing for an empty batch', () => {
    assert.equal(formatDesignNotes([]), '')
  })
})
