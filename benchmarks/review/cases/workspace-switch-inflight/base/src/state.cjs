exports.create = () => {
  let epoch = 0, rows = []
  return {
    async open(load) {
      const requestEpoch = ++epoch
      const result = await load()
      if (requestEpoch === epoch) rows = result
    },
    rows() { return rows },
  }
}
