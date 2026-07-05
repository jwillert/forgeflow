import type {
  AgentCommand,
  ChangeRequestDetails,
  ChangeRequestRef,
  CheckoutSpec,
  CodeTargetRef,
  CommentRef,
  GeneralComment,
  InlineReviewComment,
  ReviewThread,
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
  /** Other issues/change requests that block this target from proceeding (native forge relationships and/or a "Blocked by #N" text convention in the body). */
  listBlockingIssues(target: WorkTargetRef): Promise<WorkTargetRef[]>
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

/**
 * Forge-agnostic surface for reviewing a change request (GitHub pull request /
 * GitLab merge request) or discussing an issue. `listGeneralComments` works for
 * any WorkTargetRef (issue or change request); the rest are change-request only.
 */
export interface CodeReviewHost {
  getChangeRequestDetails(target: WorkTargetRef): Promise<ChangeRequestDetails>
  listGeneralComments(target: WorkTargetRef): Promise<GeneralComment[]>
  listReviewThreads(target: WorkTargetRef): Promise<ReviewThread[]>
  postReview(target: WorkTargetRef, input: { commitSha: string; summary: string; inlineComments: InlineReviewComment[] }): Promise<void>
  replyToThread(target: WorkTargetRef, input: { threadId: string; body: string }): Promise<void>
  markReady(target: WorkTargetRef): Promise<void>
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
