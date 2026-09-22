// The sum of a list of prices.
function total(prices) {
  return prices.reduce((sum, price) => sum + price, 0)
}
module.exports = { total }
