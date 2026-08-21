import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCanvasPrototypeSteeringPrompt,
  CANVAS_ARTEFACT_TOOL,
  shouldSteerCanvasPrototype,
} from './canvas-prototype-steering.ts'

describe('canvas prototype steering policy', () => {
  it('recognises requests to produce a prototype', () => {
    const positives = [
      'Can you prototype a settings screen for the mobile app?',
      'Build a quick prototype of a sales dashboard',
      'Mock up a pricing page with three tiers',
      "I'd like a wireframe of the onboarding flow",
      'Make a proof of concept for the new search UI',
      'Throw together a rough draft of the reporting screen',
      'Design a mockup of the notification centre',
    ]
    for (const prompt of positives) assert.equal(shouldSteerCanvasPrototype(prompt), true, prompt)
  })

  it('abstains from questions about an existing prototype', () => {
    const negatives = [
      'Review this prototype and tell me what is wrong with it',
      'Explain how the wireframe maps onto the components',
      'Fix the spacing in the mockup',
      'What do you think of this prototype?',
      'Refactor the proof of concept into real code',
      'Walk me through the wireframe',
    ]
    for (const prompt of negatives) assert.equal(shouldSteerCanvasPrototype(prompt), false, prompt)
  })

  it('abstains from build requests that are not prototypes', () => {
    const negatives = [
      'Build a command-line invoicing tool',
      'Create a landing page for my accounting firm',
      'Make the retry count configurable',
      'Design a logo for Crumb & Bloom',
      'prototype', // too short to carry an intent
    ]
    for (const prompt of negatives) assert.equal(shouldSteerCanvasPrototype(prompt), false, prompt)
  })

  it('names the tool it was handed rather than the bare canvas tool', () => {
    const prefixed = `mcp__copse-canvas__${CANVAS_ARTEFACT_TOOL}`
    const prompt = buildCanvasPrototypeSteeringPrompt(prefixed)
    assert.match(prompt, new RegExp(prefixed))
    // The unprefixed name must not appear on its own — the model cannot call it.
    assert.doesNotMatch(prompt, new RegExp(`(?<!__)\\b${CANVAS_ARTEFACT_TOOL}\\b`))
  })

  it('states the file-first, sandbox, and refresh-in-place contract', () => {
    const prompt = buildCanvasPrototypeSteeringPrompt('render_html_artefact')
    assert.match(prompt, /self-contained HTML/i)
    assert.match(prompt, /write the document to a real workspace file first/i)
    assert.match(prompt, /without an approval prompt/i)
    assert.match(prompt, /no CDN scripts/i)
    assert.match(prompt, /refreshes in place/i)
    assert.match(prompt, /Render first, then ask/i)
  })
})
