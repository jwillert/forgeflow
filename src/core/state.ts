import type { AgentCommand, AgentCommandStatus, ChangeRequestRef, ExecutionResult, NormalizedEvent } from "./types.js"

export interface StateStore {
  getCursor(sourceKey: string): Promise<{ value?: string } | undefined>
  setCursor(sourceKey: string, cursor?: { value?: string }): Promise<void>

  hasProcessedEvent(eventId: string): Promise<boolean>
  recordEvent(event: NormalizedEvent, options?: { rawPayload?: unknown }): Promise<void>
  markEventProcessed(eventId: string): Promise<void>

  hasCommand(commandId: string): Promise<boolean>
  createCommand(command: AgentCommand): Promise<void>
  updateCommandStatus(commandId: string, status: AgentCommandStatus, input?: { reason?: string; nextCheckAt?: string }): Promise<void>
  getCommand(commandId: string): Promise<AgentCommand | undefined>
  findLatestFailedCommandForTarget(targetKey: string): Promise<AgentCommand | undefined>
  listDueDeferred(now: string, limit: number): Promise<AgentCommand[]>
  claimQueued(limit: number): Promise<AgentCommand[]>

  getLinkedChangeRequest(commandId: string): Promise<ChangeRequestRef | undefined>
  linkChangeRequest(commandId: string, ref: ChangeRequestRef): Promise<void>

  getLastExecutionResult(commandId: string): Promise<ExecutionResult | undefined>
  recordWorkflowRun(input: {
    commandId: string
    workflowId: string
    status: "running" | "succeeded" | "failed"
    startedAt?: string
    completedAt?: string
    summary?: string
    execution?: ExecutionResult
    error?: string
  }): Promise<void>
}

export function createCommandState(state: StateStore, commandId: string) {
  return {
    getLinkedChangeRequest: () => state.getLinkedChangeRequest(commandId),
    linkChangeRequest: (ref: ChangeRequestRef) => state.linkChangeRequest(commandId, ref),
    getLastExecutionResult: () => state.getLastExecutionResult(commandId),
  }
}
