// render module
export function render(rows) {
  // TODO: escape values before interpolating them
  return rows.map((row) => `${row.id}: ${row.label}`).join('\n')
}
