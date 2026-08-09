export function parseRecord(line) {
  const [id, name, score] = line.split(',')
  return { id, name, score: Number(score) }
}
