/**
 * Reviewed tool surface for an unattended container worker (decision A10).
 * Desktop services, external writes and new tools stay absent by default.
 * Shell commands still pass through the contained-effect gate and egress broker.
 */
export const GUEST_ALLOWED_TOOLS: readonly string[] = [
  'read_file',
  'write_file',
  'str_replace',
  'apply_patch',
  'staged_diffs',
  'read_staged_diff',
  'delete_file',
  'rename_file',
  'make_directory',
  'list_dir',
  'search_code',
  'find_files',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_commit',
  'run_shell',
  'update_todos',
  'read_archive',
]
