const form = document.querySelector('#signup-form');
const note = document.querySelector('#form-note');
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const email = new FormData(form).get('email');
  if (!email) return;
  note.textContent = "You're on the list — we'll save you the first swirl.";
  note.classList.add('success');
  form.querySelector('button span:first-child').textContent = 'You’re in!';
  form.querySelector('input').value = '';
});