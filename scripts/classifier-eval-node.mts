import { readFile } from 'node:fs/promises'
import { classifyBatch } from '@copse/llm/classifiers/index.ts'
import {
  parseClassifierEvalArgs,
  parseClassifierEvalProfile,
  writeClassifierEval,
} from './classifier-eval.ts'

async function main(): Promise<number> {
  const args = parseClassifierEvalArgs(process.argv.slice(2))
  if (!args.config) throw new Error('The headless runner requires --config.')
  const profile = parseClassifierEvalProfile(await readFile(args.config, 'utf8'))
  const connection = profile.connection
  const apiKey =
    connection.type === 'http' && connection.auth === 'bearer' && connection.apiKeyEnv
      ? process.env[connection.apiKeyEnv]?.trim()
      : undefined
  if (connection.type === 'http' && connection.auth === 'bearer' && !apiKey) {
    throw new Error('Set the API key in the environment variable named by connection.apiKeyEnv.')
  }
  return writeClassifierEval(args, profile, (requests, options) =>
    classifyBatch(profile, requests, { ...options, ...(apiKey ? { apiKey } : {}) }),
  )
}

void main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Classifier eval failed.')
    process.exitCode = 2
  },
)
