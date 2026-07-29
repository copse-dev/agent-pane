import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CLAUDE_PUBLISHED_HOOK_EVENTS,
  CLAUDE_INTENTIONALLY_UNSUPPORTED_EVENTS,
  CLAUDE_SCHEMA_PIN,
  CURSOR_PUBLISHED_HOOK_EVENTS,
  CURSOR_INTENTIONALLY_UNSUPPORTED_EVENTS,
  CURSOR_SCHEMA_PIN,
} from '@shared/hooks/vendored-hook-schemas.ts'
import { CURSOR_WIRED_HOOK_EVENTS } from '@shared/types/cursor-hooks.ts'
import { CLAUDE_WIRED_HOOK_EVENTS } from './claude-adapter.ts'
import { expectRecord } from '@shared/unknown-value.ts'

// G3 — Vendored schemas + CI drift detector.
//
// The pinned, committed upstream schemas under `schemas/vendor/` publish the
// event surface each foreign dialect offers. This test diffs those published
// lists against the events our adapters actually wire and fails when they drift:
// an upstream release that adds an event we neither support nor have listed as
// intentionally-unsupported must be a deliberate choice (wire it or document it),
// never silent drift.
//
// It **only ever reads the committed copies from disk** — never the network
// (G3: never remote-fetched). It works fully offline.

/** Read a vendored schema JSON from disk (repo root) — no network, ever. */
async function readVendoredSchema(relPath: string): Promise<Record<string, unknown>> {
  const abs = join(process.cwd(), relPath)
  await stat(abs) // exists (fails loudly if the pin file was removed)
  return expectRecord(JSON.parse(await readFile(abs, 'utf-8')) as unknown)
}

/** The event names a hook schema publishes = the keys of its `hooks` object's `properties`. */
function publishedEvents(schema: Record<string, unknown>): string[] {
  const properties = (schema as { properties?: { hooks?: { properties?: unknown } } }).properties
  const hookProps = properties?.hooks?.properties
  assert.ok(
    hookProps && typeof hookProps === 'object',
    'vendored schema is missing properties.hooks.properties',
  )
  return Object.keys(hookProps).sort()
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort()

describe('vendor-schema-drift (G3)', () => {
  describe('vendored Cursor community schema', () => {
    it('publishes exactly the mirrored event list (JSON ↔ TS pin)', async () => {
      const schema = await readVendoredSchema(CURSOR_SCHEMA_PIN.vendoredPath)
      assert.deepEqual(publishedEvents(schema), sorted(CURSOR_PUBLISHED_HOOK_EVENTS))
    })

    it('accounts for every published event: wired or intentionally-unsupported', () => {
      // The drift invariant: intentionally-unsupported == published \ wired. If
      // a re-vendored schema adds an event we do not wire, this fails until it is
      // wired or added to CURSOR_INTENTIONALLY_UNSUPPORTED_EVENTS with a reason.
      const wired = new Set<string>(CURSOR_WIRED_HOOK_EVENTS)
      const publishedNotWired = CURSOR_PUBLISHED_HOOK_EVENTS.filter((e) => !wired.has(e))
      assert.deepEqual(
        sorted(publishedNotWired),
        sorted(CURSOR_INTENTIONALLY_UNSUPPORTED_EVENTS),
        'Cursor: published-but-unwired events must exactly match the intentionally-unsupported list',
      )
    })

    it('never lists a supported event as intentionally-unsupported', () => {
      const unsupported = new Set<string>(CURSOR_INTENTIONALLY_UNSUPPORTED_EVENTS)
      for (const e of CURSOR_WIRED_HOOK_EVENTS) {
        assert.equal(unsupported.has(e), false, `wired Cursor event "${e}" is marked unsupported`)
      }
    })
  })

  describe('vendored Claude SchemaStore schema', () => {
    it('publishes exactly the mirrored event list (JSON ↔ TS pin)', async () => {
      const schema = await readVendoredSchema(CLAUDE_SCHEMA_PIN.vendoredPath)
      assert.deepEqual(publishedEvents(schema), sorted(CLAUDE_PUBLISHED_HOOK_EVENTS))
    })

    it('accounts for every published event: wired or intentionally-unsupported', () => {
      const wired = new Set<string>(CLAUDE_WIRED_HOOK_EVENTS)
      const publishedNotWired = CLAUDE_PUBLISHED_HOOK_EVENTS.filter((e) => !wired.has(e))
      assert.deepEqual(
        sorted(publishedNotWired),
        sorted(CLAUDE_INTENTIONALLY_UNSUPPORTED_EVENTS),
        'Claude: published-but-unwired events must exactly match the intentionally-unsupported list',
      )
    })

    it('wires only events the vendored schema actually publishes (no phantom events)', () => {
      const published = new Set<string>(CLAUDE_PUBLISHED_HOOK_EVENTS)
      for (const e of CLAUDE_WIRED_HOOK_EVENTS) {
        assert.equal(
          published.has(e),
          true,
          `wired Claude event "${e}" is not in the vendored schema`,
        )
      }
    })

    it('never double-lists an event as both supported and intentionally-unsupported', () => {
      const unsupported = new Set<string>(CLAUDE_INTENTIONALLY_UNSUPPORTED_EVENTS)
      for (const e of CLAUDE_WIRED_HOOK_EVENTS) {
        assert.equal(unsupported.has(e), false, `wired Claude event "${e}" is marked unsupported`)
      }
    })
  })
})
