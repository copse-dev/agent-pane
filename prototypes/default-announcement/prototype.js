const announcement = document.querySelector('#announcement')
const appearance = document.querySelector('#appearance-dialog')
const status = document.querySelector('#preview-status')

function showAnnouncement(context) {
  if (appearance.open) appearance.close()
  if (context === 'fresh install') {
    if (announcement.open) announcement.close()
    status.textContent = 'Preview: fresh install · no announcements'
    return
  }
  status.textContent = `Preview: ${context}`
  if (!announcement.open) announcement.showModal()
  document.querySelector('#acknowledge').focus()
}
function showAppearance() {
  announcement.close()
  appearance.showModal()
}
document.querySelector('#acknowledge').addEventListener('click', () => announcement.close())
document.querySelector('#appearance').addEventListener('click', showAppearance)
document.querySelector('#settings').addEventListener('click', showAppearance)
document.querySelector('#done').addEventListener('click', () => appearance.close())
document.querySelector('#fresh').addEventListener('click', () => showAnnouncement('fresh install'))
document.querySelector('#update').addEventListener('click', () => showAnnouncement('after update'))
document.querySelector('#theme').addEventListener('click', (event) => {
  const light = document.documentElement.dataset.theme !== 'light'
  document.documentElement.dataset.theme = light ? 'light' : 'dark'
  event.currentTarget.textContent = light ? 'Dark theme' : 'Light theme'
})
showAnnouncement(
  new URLSearchParams(location.search).get('context') === 'fresh'
    ? 'fresh install'
    : 'after update',
)
