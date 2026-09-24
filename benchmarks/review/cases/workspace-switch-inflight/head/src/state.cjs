exports.create = () => {
  let rows = []
  return {
    async open(load) {
      rows = await load()
    },
    rows() { return rows },
  }
}
