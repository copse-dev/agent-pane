#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { terminalBenchCapsulesRoot } from './lib/terminal-bench.mts'

interface CapsuleUpload {
  archive: string
  sha256: string
}

function property(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function capsuleUploads(value: unknown): CapsuleUpload[] {
  const capsules = property(value, 'capsules')
  if (!Array.isArray(capsules)) throw new Error('capsule index is invalid')
  return capsules.map((capsule) => {
    const archive = property(capsule, 'archive')
    const sha256 = property(capsule, 'sha256')
    if (
      typeof archive !== 'string' ||
      basename(archive) !== archive ||
      !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(archive) ||
      typeof sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(sha256)
    ) {
      throw new Error('capsule index contains unsafe upload metadata')
    }
    return { archive, sha256 }
  })
}

function uploadReceipts(value: string): Map<string, string> {
  const receipts = new Map<string, string>()
  for (const line of value.split('\n')) {
    if (!line) continue
    const [sha256, archive, ...extra] = line.split('\t')
    if (
      !sha256 ||
      !archive ||
      extra.length > 0 ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      basename(archive) !== archive ||
      !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(archive)
    ) {
      throw new Error('capsule upload receipt is invalid')
    }
    receipts.set(archive, sha256)
  }
  return receipts
}

async function optionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
      return ''
    }
    throw error
  }
}

const capsulesRoot = terminalBenchCapsulesRoot()
const indexPath = resolve(process.argv[2] ?? resolve(capsulesRoot, 'index.json'))
const receiptsPath = resolve(process.argv[3] ?? resolve(capsulesRoot, '.uploaded-capsules.tsv'))
const uploads = capsuleUploads(JSON.parse(await readFile(indexPath, 'utf8')))
const receipts = uploadReceipts(await optionalFile(receiptsPath))

for (const upload of uploads) {
  if (receipts.get(upload.archive) !== upload.sha256) {
    process.stdout.write(`${upload.sha256}\t${upload.archive}\n`)
  }
}
