exports.create = () => {
  const titles = new Map([[42, 'Anchor annotations']])
  let rows = [{ number: 42, title: 'Anchor annotations' }]
  return {
    refresh() { rows = [{ number: 42, title: '#42' }] },
    render(query) {
      for (const row of rows) row.title = titles.get(row.number) || row.title
      return rows.filter(row => row.title.includes(query))
    },
  }
}
