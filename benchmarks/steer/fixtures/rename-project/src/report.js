import { parseRecord } from './parse.js'

export function buildReport(lines) {
  return lines.map(parseRecord).filter((r) => r.score > 0)
}
