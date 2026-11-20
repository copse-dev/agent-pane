import { el } from '../../dom/helpers.ts'

/**
 * "Your machines": every computer Copse can reach, listed once at the top of
 * Settings → Machines (docs/plans/multi-machine-access.md, slice M2).
 *
 * The SSH and paired-machine sections keep their own data, forms and actions;
 * they render their rows into the two slots here instead of into lists of
 * their own, so each machine appears in one place with its status and what it
 * can be used for. Nothing is merged or migrated.
 */
export interface MachinesOverview {
  readonly root: HTMLFieldSetElement
  /** Rows for saved SSH machines (`.ssh-host-row`). */
  readonly sshRows: HTMLElement
  /** Rows for paired Copse machines (`.machine-row`). */
  readonly pairedRows: HTMLElement
}

export function createMachinesOverview(options: { onAddSshMachine: () => void }): MachinesOverview {
  const sshRows = el('div', { class: 'ssh-host-list machines-overview-ssh' })
  const pairedRows = el('div', { class: 'machine-list machines-overview-paired' })
  const add = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary machines-overview-add' },
    'Add SSH machine',
  )
  add.addEventListener('click', options.onAddSshMachine)
  const root = el(
    'fieldset',
    { class: 'machines-overview' },
    el('legend', {}, 'Your machines'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Each computer Copse can reach, how it is connected, and what you can use it for. ',
      'Machines reached over SSH use your own SSH setup; paired Copse machines share their models.',
    ),
    sshRows,
    pairedRows,
    el('div', { class: 'provider-actions' }, add),
  )
  return { root, sshRows, pairedRows }
}
