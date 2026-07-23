import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  terminalBenchProfile,
  type TerminalBenchProfile,
  type TerminalBenchProfileId,
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
  profileId: TerminalBenchProfileId,
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
    value = JSON.parse(await readFile(join(dirname(resultPath), PROFILE_METADATA_FILE), 'utf8'))
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
  const profile = terminalBenchProfile(rawProfile)
  if (rawProfile !== profile.versionedId || rawHash !== profile.contentHash) {
    throw new Error(`Inconsistent retained Terminal-Bench profile metadata for ${resultPath}`)
  }
  return profile
}
