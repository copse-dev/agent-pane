import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldSteerSiteBuilding, SITE_BUILDING_STEERING_PROMPT } from './site-building-steering.ts'

describe('site-building steering policy', () => {
  it('recognises natural implementation briefs, including the one-turn cupcake eval', () => {
    const positives = [
      'Build a polished coming-soon site for Crumb & Bloom, a playful premium cupcake studio. Include email signup, make it feel handcrafted, and preview it when done.',
      'Create a landing page for my accounting firm',
      'Please redesign our portfolio website',
      'Polish this marketing page and make it responsive',
      'Implement the new homepage from the supplied assets',
    ]
    for (const prompt of positives) assert.equal(shouldSteerSiteBuilding(prompt), true, prompt)
  })

  it('abstains from explanations, reviews, non-web design, and vague actions', () => {
    const negatives = [
      'Explain how this website works',
      'Review the accessibility of our landing page',
      'Audit this homepage for conversion issues',
      'Build a command-line invoicing tool',
      'Design a logo for Crumb & Bloom',
      'What do you think of this portfolio?',
    ]
    for (const prompt of negatives) assert.equal(shouldSteerSiteBuilding(prompt), false, prompt)
  })

  it('sets quality and clarification policy without leaking demo-specific art direction', () => {
    assert.match(SITE_BUILDING_STEERING_PROMPT, /visual direction/i)
    assert.match(SITE_BUILDING_STEERING_PROMPT, /accessibility/i)
    assert.match(SITE_BUILDING_STEERING_PROMPT, /reduced-motion/i)
    assert.match(SITE_BUILDING_STEERING_PROMPT, /ask one compact creative-brief question/i)
    assert.match(SITE_BUILDING_STEERING_PROMPT, /make coherent assumptions and build immediately/i)
    assert.match(SITE_BUILDING_STEERING_PROMPT, /local browser or preview/i)
    assert.match(SITE_BUILDING_STEERING_PROMPT, /bare http:\/\/ URL on its own line/i)
    assert.doesNotMatch(SITE_BUILDING_STEERING_PROMPT, /cupcake|crumb|bloom/i)
  })
})
