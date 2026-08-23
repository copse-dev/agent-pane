// ingest module
export function ingest(rows) {
  // TODO: validate the row shape before mapping
  return rows.map((row) => {
    // TODO: drop rows whose timestamp is in the future
    return { ...row, seen: true }
  })
}

// TODO: stream large inputs instead of buffering
