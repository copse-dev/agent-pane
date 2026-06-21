export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export type TodoCheck =
  | { kind: 'shell'; command: string; expectExit?: number }
  | { kind: 'fileExists'; path: string }
  | { kind: 'typecheck' }

export type TodoAssignedModel = 'cloud' | 'local'

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
  check?: TodoCheck
  assignedModel?: TodoAssignedModel
}

export interface TodoUpdateInput {
  id?: string
  content: string
  status: TodoStatus
  check?: TodoCheck
  assignedModel?: TodoAssignedModel
}
