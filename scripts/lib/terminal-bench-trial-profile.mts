import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from './safe-json.mts'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  terminalBenchProfile,
  terminalBenchProfileForIdentity,
  type TerminalBenchProfile,
} from './terminal-bench-profiles.mts'

const PROFILE_METADATA_FILE = 'terminal-bench-profile.json'

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && field(error, 'code') === 'ENOENT'
}

export async function recordTerminalBenchTrialProfile(
  resultPath: string,
  profileId: string | undefined,
): Promise<void> {
  const profile = terminalBenchProfile(profileId)
  await writeFile(
    join(dirname(resultPath), PROFILE_METADATA_FILE),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        profile: profile.versionedId,
        contentHash: profile.contentHash,
      },
      null,
      2,
    )}\n`,
  )
}

export async function readTerminalBenchTrialProfile(
  resultPath: string,
): Promise<TerminalBenchProfile | undefined> {
  let value: unknown
  try {
    value = safeJsonParse(
      await readFile(join(dirname(resultPath), PROFILE_METADATA_FILE), 'utf8'),
      decodeWithSchema(
        z
          .object({
            schemaVersion: z.literal(1),
            profile: z.string(),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      ),
    )
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw new Error(
      `Invalid retained Terminal-Bench profile metadata for ${resultPath}: ${String(error)}`,
      { cause: error },
    )
  }
  const rawProfile = field(value, 'profile')
  const rawHash = field(value, 'contentHash')
  if (field(value, 'schemaVersion') !== 1 || typeof rawProfile !== 'string') {
    throw new Error(`Invalid retained Terminal-Bench profile metadata for ${resultPath}`)
  }
  if (typeof rawHash !== 'string')
    throw new Error(`Invalid retained Terminal-Bench profile metadata for ${resultPath}`)
  let profile: TerminalBenchProfile
  try {
    profile = terminalBenchProfileForIdentity(rawProfile, rawHash)
  } catch (error) {
    throw new Error(`Inconsistent retained Terminal-Bench profile metadata for ${resultPath}`, {
      cause: error,
    })
  }
  return profile
}
