// report module
export function report(rows) {
  // TODO: group by day rather than by raw timestamp
  const total = rows.length
  // TODO: report medians alongside the mean
  const mean = rows.reduce((sum, row) => sum + row.value, 0) / (total || 1)
  // TODO: fold in the ingest warnings
  // TODO: emit CSV as well as text
  return { total, mean }
}

// TODO: cache the last report for the dashboard
