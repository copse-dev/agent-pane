exports.create = () => {
  let rows = []
  return {
    async refresh(load) { rows = await load() },
    dispose() { rows = [] },
    rows() { return rows },
  }
}
