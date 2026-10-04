import { z } from 'zod'
import { isRecord } from '@copse/std/unknown-value.ts'

const chromeOptionsSchema = z.looseObject({ args: z.array(z.string()).optional() })
interface ChromeOptions {
  [key: string]: unknown
  args?: string[]
}

function decodeChromeOptions(value: unknown): ChromeOptions {
  const { args, ...metadata } = chromeOptionsSchema.parse(value)
  return { ...metadata, ...(args === undefined ? {} : { args }) }
}

function chromeCapabilityRoot(capabilities: unknown): Record<string, unknown> {
  if (!isRecord(capabilities)) throw new Error('Expected Chrome session capabilities')
  const root = isRecord(capabilities['alwaysMatch']) ? capabilities['alwaysMatch'] : capabilities
  if (root['browserName'] !== 'chrome' && !Object.hasOwn(root, 'goog:chromeOptions')) {
    throw new Error('Expected standalone Chrome session capabilities')
  }
  return root
}

export function readChromeOptions(capabilities: unknown): ChromeOptions {
  return decodeChromeOptions(chromeCapabilityRoot(capabilities)['goog:chromeOptions'] ?? {})
}

/** Mutate the actual standalone/W3C session options after validating their argument list. */
export function updateChromeOptions(
  capabilities: unknown,
  update: (options: ChromeOptions) => ChromeOptions,
): void {
  const root = chromeCapabilityRoot(capabilities)
  const options = decodeChromeOptions(root['goog:chromeOptions'] ?? {})
  root['goog:chromeOptions'] = update(options)
}
