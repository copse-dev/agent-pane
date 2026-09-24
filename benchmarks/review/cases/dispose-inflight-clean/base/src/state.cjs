exports.create = () => {
  let disposed = false, rows = []
  return {
    async refresh(load) {
      const result = await load()
      if (!disposed) rows = result
    },
    dispose() { disposed = true; rows = [] },
    rows() { return rows },
  }
}
