// The display name for a user record, or null for no user.
function displayName(user) {
  return user.nickname || user.name
}
module.exports = { displayName }
