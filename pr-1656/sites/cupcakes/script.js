const form = document.querySelector('#waitlist');
const email = document.querySelector('#email');
const status = document.querySelector('#form-status');
const art = document.querySelector('.hero__art');
const stillLife = document.querySelector('.still-life');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

form.addEventListener('submit', (event) => {
  event.preventDefault();
  status.classList.remove('is-error', 'is-success');

  if (!email.checkValidity()) {
    status.textContent = 'Please enter a valid email address.';
    status.classList.add('is-error');
    email.setAttribute('aria-invalid', 'true');
    email.focus();
    return;
  }

  email.removeAttribute('aria-invalid');
  status.textContent = 'You’re on the list — save room for something lovely.';
  status.classList.add('is-success');
  form.reset();
});

email.addEventListener('input', () => {
  email.removeAttribute('aria-invalid');
  if (status.classList.contains('is-error')) {
    status.textContent = 'Opening notes, first tastes, no crumbs in your inbox.';
    status.classList.remove('is-error');
  }
});

if (!reduceMotion.matches) {
  art.addEventListener('pointermove', (event) => {
    const bounds = art.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 10;
    const y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 10;
    stillLife.style.setProperty('--art-x', `${x}px`);
    stillLife.style.setProperty('--art-y', `${y}px`);
  });

  art.addEventListener('pointerleave', () => {
    stillLife.style.setProperty('--art-x', '0px');
    stillLife.style.setProperty('--art-y', '0px');
  });
}
