import { guessFilename } from '../core/loaders';
import { TOUCH, matches } from './media';
import { el } from './dom';
import { icon } from './icons';

export type OpenRequest =
  | { kind: 'example' }
  | { kind: 'github'; url: string }
  | { kind: 'folder'; files: FileList }
  | { kind: 'paste'; filename: string; text: string }
  // Handed over by an embedding host (Copse), not opened from this dialog.
  | { kind: 'embedded'; files: { path: string; content: string }[]; name?: string };

export interface OpenDialogProps {
  onOpen: (r: OpenRequest) => void;
  onClose: () => void;
  canClose: boolean;
  lastUrl: string;
}

export interface OpenDialogHandle {
  destroy(): void;
}

export function mountOpenDialog(container: HTMLElement, props: OpenDialogProps): OpenDialogHandle {
  const { onOpen, onClose, canClose, lastUrl } = props;
  let url = lastUrl;
  let paste = false;
  let text = '';
  let filename = 'main.py';
  // The file name follows the pasted code's language until it is edited.
  let named = false;

  const scrim = el('div', { class: 'scrim' });
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim && canClose) onClose();
  });
  const section = el('section', { class: 'open-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'open-title' });
  scrim.append(section);
  container.append(scrim);

  const folderInput = el('input', { type: 'file', multiple: true, hidden: true }) as HTMLInputElement;
  folderInput.addEventListener('change', () => {
    if (folderInput.files?.length) onOpen({ kind: 'folder', files: folderInput.files });
    folderInput.value = '';
  });
  folderInput.setAttribute('webkitdirectory', '');

  const urlInput = el('input', {
    value: url,
    placeholder: 'github.com/owner/repo, or a pull request',
    'aria-label': 'GitHub repository, pull request or comparison',
    spellcheck: 'false',
  }) as HTMLInputElement;
  const submitBtn = el('button', { class: 'primary', type: 'submit', disabled: !url.trim() }, 'Open') as HTMLButtonElement;
  urlInput.addEventListener('input', () => {
    url = urlInput.value;
    submitBtn.disabled = !url.trim();
  });
  const form = el('form', { class: 'open-row' }, icon('link2', 17), urlInput, submitBtn);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (url.trim()) onOpen({ kind: 'github', url });
  });

  const pasteSection = el('div', { class: 'paste' });
  const filenameInput = el('input', { value: filename, 'aria-label': 'Filename', spellcheck: 'false' }) as HTMLInputElement;
  filenameInput.addEventListener('input', () => {
    filename = filenameInput.value;
    named = true;
  });
  const textArea = el('textarea', {
    placeholder: 'Paste Python, JavaScript, TypeScript, Rust or Go here…',
    spellcheck: 'false',
    'aria-label': 'Code',
  }) as HTMLTextAreaElement;
  textArea.value = text;
  const visualizeBtn = el('button', { class: 'primary', disabled: !text.trim() }, 'Visualize') as HTMLButtonElement;
  textArea.addEventListener('input', () => {
    text = textArea.value;
    if (!named) {
      filename = guessFilename(text);
      filenameInput.value = filename;
    }
    visualizeBtn.disabled = !text.trim();
  });
  visualizeBtn.addEventListener('click', () => {
    onOpen({ kind: 'paste', filename, text });
  });
  pasteSection.append(filenameInput, textArea, visualizeBtn);

  const pasteToggle = el(
    'button',
    { 'aria-expanded': String(paste) },
    icon('fileCode', 17),
    el('span', {}, el('strong', {}, 'Paste code'), el('small', {}, 'a single file')),
  );

  function syncPasteVisibility(): void {
    pasteToggle.setAttribute('aria-expanded', String(paste));
    pasteSection.hidden = !paste;
  }
  pasteToggle.addEventListener('click', () => {
    paste = !paste;
    syncPasteVisibility();
  });
  syncPasteVisibility();

  const folderBtn = el(
    'button',
    {},
    icon('folderOpen', 17),
    el('span', {}, el('strong', {}, 'Local folder…'), el('small', {}, matches(TOUCH) ? 'or files on this device' : 'or drop a folder anywhere')),
  );
  folderBtn.addEventListener('click', () => folderInput.click());

  const exampleBtn = el(
    'button',
    {},
    icon('sparkles', 17),
    el('span', {}, el('strong', {}, 'nanoGPT example'), el('small', {}, 'karpathy/nanoGPT, bundled')),
  );
  exampleBtn.addEventListener('click', () => onOpen({ kind: 'example' }));

  const options = el('div', { class: 'open-options' }, exampleBtn, folderBtn, pasteToggle);

  const headerText = el(
    'div',
    {},
    el('h1', { id: 'open-title' }, 'Open a codebase'),
    el(
      'p',
      {},
      'Code is analyzed in your browser with Rust/WebAssembly. Nothing is uploaded or executed. A pull request (…/pull/123) or comparison (…/compare/main...dev) shows what it changes.',
    ),
  );
  const header = el('header', {}, headerText);
  if (canClose) {
    const closeBtn = el('button', { class: 'icon', 'aria-label': 'Close' }, icon('x', 16));
    closeBtn.addEventListener('click', onClose);
    header.append(closeBtn);
  }

  section.append(header, form, options, pasteSection, folderInput);

  // On a phone, focusing would cover the choices with the keyboard.
  if (!matches(TOUCH)) urlInput.focus();

  return {
    destroy(): void {
      scrim.remove();
    },
  };
}
