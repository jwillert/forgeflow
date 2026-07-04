import type {
  AgentCommand,
  ChangeRequestRef,
  CheckoutSpec,
  CodeTargetRef,
  CommentRef,
  WorkTargetRef,
  WorkTargetSnapshot,
} from "./types.js"

export interface PollingEventSource {
  readonly provider: string
  readonly targetId: string
  poll(input: { cursor?: { value?: string }; maxEvents: number }): Promise<{ events: import("./types.js").NormalizedEvent[]; nextCursor?: { value?: string } }>
}

export interface WorkReader {
  getTarget(target: WorkTargetRef): Promise<WorkTargetSnapshot>
}

export interface WorkTracker extends WorkReader {
  addLabel(target: WorkTargetRef, label: string): Promise<void>
  removeLabel(target: WorkTargetRef, label: string): Promise<void>
  addComment(target: WorkTargetRef, body: string): Promise<CommentRef>
}

export interface CodeReader {
  resolveCheckout(target: CodeTargetRef, command: AgentCommand): Promise<CheckoutSpec>
}

export interface CodeHost extends CodeReader {
  openOrUpdateChangeRequest(input: {
    existing?: ChangeRequestRef
    sourceBranch: import("./types.js").BranchRef
    targetBranch: string
    title: string
    body: string
  }): Promise<ChangeRequestRef>
}

export interface CapabilityRegistry {
  optional<T = unknown>(name: string): T | undefined
}

export interface TrustPolicy {
  canProcessEvent(input: { event: import("./types.js").NormalizedEvent; workflowKind?: "read" | "write" }): Promise<{ allowed: boolean; reason?: string }>
}

export interface CommandState {
  getLinkedChangeRequest(): Promise<ChangeRequestRef | undefined>
  linkChangeRequest(ref: ChangeRequestRef): Promise<void>
  getLastExecutionResult(): Promise<import("./types.js").ExecutionResult | undefined>
}
