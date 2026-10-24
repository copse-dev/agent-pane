import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { e2eKnowledgeDir } from './seed-config.ts'

/** Pin display metadata after the spec has exercised the real save operation. */
export function pinRoadmapDisplayTimestamp(projectId: string): void {
  const roadmapDir = join(e2eKnowledgeDir(), projectId, 'roadmap')
  const files = readdirSync(roadmapDir).filter((name) => name.endsWith('.md'))
  const [file] = files
  assert.ok(file !== undefined && files.length === 1, 'expected exactly one roadmap note')
  const notePath = join(roadmapDir, file)
  const note = readFileSync(notePath, 'utf8')
  assert.match(note, /^updatedAt: .+$/m)
  writeFileSync(notePath, note.replace(/^updatedAt: .+$/m, 'updatedAt: 2026-01-15T09:00:00.000Z'))
}
