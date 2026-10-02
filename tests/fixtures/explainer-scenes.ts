/** Acceptance examples, not product presets: the tool composes these actions. */
export const reviewSceneStory = {
  project: 'Copse',
  title: 'Approve changes. Keep control.',
  style: 'paper',
  duration: 30,
  source:
    'Conceptual illustration of the proposed-change queue: approval applies a queued edit; rejection discards a pending proposal. Already-applied edits require a separate undo.',
  objects: [
    { id: 'desk', kind: 'workspace', label: 'Your saved file', x: 25, y: 50, color: 'blue' },
    {
      id: 'file',
      kind: 'document',
      label: 'home.ts',
      x: 25,
      y: 53,
      content: 'Hello',
      color: 'blue',
    },
    {
      id: 'good',
      kind: 'document',
      label: 'Proposed edit',
      x: 56,
      y: 53,
      content: 'Welcome',
      color: 'green',
    },
    {
      id: 'bad',
      kind: 'document',
      label: 'Another proposal',
      x: 56,
      y: 53,
      content: 'Remove heading',
      color: 'coral',
      visible: false,
    },
    { id: 'bin', kind: 'bin', label: 'Discarded proposals', x: 85, y: 60, color: 'coral' },
  ],
  scenes: [
    {
      title: 'A suggestion is waiting',
      caption: 'Compare your saved file with the proposed edit. Your file has not changed yet.',
      actions: [{ type: 'highlight', target: 'good' }],
    },
    {
      title: 'Approve applies the edit',
      caption: 'Approve moves the suggested change into your file. Hello becomes Welcome.',
      actions: [{ type: 'apply', from: 'good', to: 'file' }],
    },
    {
      title: 'A different suggestion arrives',
      caption: 'The next proposal would remove the heading. You can choose to reject it.',
      actions: [{ type: 'appear', target: 'bad' }],
    },
    {
      title: 'Reject discards only the proposal',
      caption: 'Reject drops the waiting suggestion. Your saved file still says Welcome.',
      actions: [{ type: 'discard', target: 'bad', to: 'bin' }],
    },
    {
      title: 'The accepted change stays',
      caption:
        'Reject does not undo an earlier accepted edit. The original saved result stays intact.',
      actions: [{ type: 'highlight', target: 'file' }],
    },
  ],
}

export const worktreeSceneStory = {
  project: 'Copse',
  title: 'Two tasks. Separate working files.',
  style: 'mailroom',
  duration: 36,
  source:
    'Conceptual example of isolated Git worktrees. Separate folders, branches and indexes prevent working-file collisions. Shared Git history does not eliminate later merge conflicts.',
  objects: [
    {
      id: 'base',
      kind: 'document',
      label: 'Original app.ts',
      x: 50,
      y: 20,
      content: 'theme: grey',
      color: 'gold',
    },
    {
      id: 'worka',
      kind: 'workspace',
      label: 'Task A · own branch',
      x: 20,
      y: 55,
      color: 'blue',
      visible: false,
    },
    {
      id: 'workb',
      kind: 'workspace',
      label: 'Task B · own branch',
      x: 80,
      y: 55,
      color: 'coral',
      visible: false,
    },
    { id: 'a', kind: 'document', label: 'A / app.ts', x: 20, y: 58, color: 'blue', visible: false },
    {
      id: 'b',
      kind: 'document',
      label: 'B / app.ts',
      x: 80,
      y: 58,
      color: 'coral',
      visible: false,
    },
    {
      id: 'result',
      kind: 'document',
      label: 'Merge review',
      x: 50,
      y: 80,
      color: 'green',
      visible: false,
    },
  ],
  scenes: [
    {
      title: 'A shared folder can collide',
      caption: 'Two tasks editing the same working file could overwrite each other.',
      actions: [{ type: 'highlight', target: 'base' }],
    },
    {
      title: 'Give each task its own workspace',
      caption:
        'In isolated mode, Copse creates a separate working folder and branch for each task.',
      actions: [
        { type: 'appear', target: 'worka' },
        { type: 'appear', target: 'workb' },
        { type: 'copy', from: 'base', to: 'a' },
        { type: 'copy', from: 'base', to: 'b' },
      ],
    },
    {
      title: 'Edit both copies independently',
      caption: 'Task A chooses blue. Task B chooses coral. Each edit changes only its own file.',
      actions: [
        { type: 'edit', target: 'a', content: 'theme: blue' },
        { type: 'edit', target: 'b', content: 'theme: coral' },
      ],
    },
    {
      title: 'Your original stays unchanged',
      caption: 'The original still says grey. Neither task changed the other task’s working file.',
      actions: [
        { type: 'highlight', target: 'base' },
        { type: 'highlight', target: 'a' },
        { type: 'highlight', target: 'b' },
      ],
    },
    {
      title: 'Compare the results later',
      caption: 'When the branches are combined, different edits to the same value can conflict.',
      actions: [{ type: 'merge', from: ['a', 'b'], to: 'result' }],
    },
    {
      title: 'Isolation does not decide the merge',
      caption:
        'Git history is shared. A conflicting result needs a decision before those edits can be combined.',
      actions: [{ type: 'highlight', target: 'result' }],
    },
  ],
}
