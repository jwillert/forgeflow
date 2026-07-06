import type { CodeHost, CodeReviewHost, PollingEventSource, TrustPolicy, WorkTracker } from "../capabilities.js"
import type {
  AgentCommand,
  BranchRef,
  ChangeRequestDetails,
  ChangeRequestRef,
  CheckoutSpec,
  CodeTargetRef,
  GeneralComment,
  InlineReviewComment,
  NormalizedEvent,
  ReviewThread,
  WorkTargetRef,
  WorkTargetSnapshot,
} from "../types.js"
import type { EnabledTarget } from "../config.js"
import type { MatchContext, MatchDecision, RunContext, Workflow, WorkflowRunResult } from "../workflow.js"

/**
 * A single fake adapter satisfying every capability interface an EnabledTarget
 * needs (PollingEventSource, WorkTracker, CodeHost, CodeReviewHost) — mirrors
 * how a real provider adapter (GitHubRepoAdapter etc.) implements all of them
 * on one class. Poll batches are queued explicitly by the test; every other
 * call is recorded for assertions and returns a stubbed, overridable default.
 */
export class FakeProviderAdapter implements PollingEventSource, WorkTracker, CodeHost, CodeReviewHost {
  readonly provider = "fake"
  readonly targetId = "fake-target"

  private pollBatches: Array<{ events: NormalizedEvent[]; nextCursor?: { value?: string } }> = []
  readonly labelCalls: Array<{ target: WorkTargetRef; op: "add" | "remove"; label: string }> = []
  readonly comments: Array<{ target: WorkTargetRef; body: string }> = []
  snapshots = new Map<string, WorkTargetSnapshot>()
  blockingIssues = new Map<string, WorkTargetRef[]>()
  changeRequestDetails: ChangeRequestDetails = {
    sourceBranch: "agent/work", sourceSha: "abc123", targetBranch: "main", title: "Fake change request", isCrossRepository: false,
  }

  queuePoll(events: NormalizedEvent[], nextCursor?: { value?: string }) {
    this.pollBatches.push({ events, nextCursor })
  }

  async poll(_input: { cursor?: { value?: string }; maxEvents: number }) {
    return this.pollBatches.shift() ?? { events: [] }
  }

  async getTarget(target: WorkTargetRef): Promise<WorkTargetSnapshot> {
    return this.snapshots.get(target.id) ?? { target, labels: [] }
  }

  async listBlockingIssues(target: WorkTargetRef): Promise<WorkTargetRef[]> {
    return this.blockingIssues.get(target.id) ?? []
  }

  async addLabel(target: WorkTargetRef, label: string): Promise<void> {
    this.labelCalls.push({ target, op: "add", label })
  }

  async removeLabel(target: WorkTargetRef, label: string): Promise<void> {
    this.labelCalls.push({ target, op: "remove", label })
  }

  async addComment(target: WorkTargetRef, body: string) {
    this.comments.push({ target, body })
    return { id: `comment-${this.comments.length}` }
  }

  async resolveCheckout(_target: CodeTargetRef, _command: AgentCommand): Promise<CheckoutSpec> {
    return { cloneUrl: "https://example.invalid/fake.git", baseRef: "main", workBranch: "agent/work", authRef: "fake:auth" }
  }

  async openOrUpdateChangeRequest(_input: { existing?: ChangeRequestRef; sourceBranch: BranchRef; targetBranch: string; title: string; body: string }): Promise<ChangeRequestRef> {
    return { provider: "fake", id: "cr-1", kind: "pull_request" }
  }

  async getChangeRequestDetails(_target: WorkTargetRef): Promise<ChangeRequestDetails> {
    return this.changeRequestDetails
  }

  async listGeneralComments(_target: WorkTargetRef): Promise<GeneralComment[]> {
    return []
  }

  async listReviewThreads(_target: WorkTargetRef): Promise<ReviewThread[]> {
    return []
  }

  async postReview(_target: WorkTargetRef, _input: { commitSha: string; summary: string; inlineComments: InlineReviewComment[] }): Promise<void> {}

  async replyToThread(_target: WorkTargetRef, _input: { threadId: string; body: string }): Promise<void> {}

  async markReady(_target: WorkTargetRef): Promise<void> {}
}

export function fakeEnabledTarget(overrides: Partial<EnabledTarget> = {}): { target: EnabledTarget; adapter: FakeProviderAdapter } {
  const adapter = new FakeProviderAdapter()
  const target: EnabledTarget = {
    provider: "fake",
    id: "fake-target",
    codeRepo: "acme/widgets",
    workflows: [],
    pollingSource: adapter,
    workReader: adapter,
    workTracker: adapter,
    codeReader: adapter,
    codeHost: adapter,
    codeReviewHost: adapter,
    ...overrides,
  }
  return { target, adapter }
}

export function allowAllTrustPolicy(): TrustPolicy {
  return { async canProcessEvent() { return { allowed: true } } }
}

export function denyAllTrustPolicy(reason = "denied"): TrustPolicy {
  return { async canProcessEvent() { return { allowed: false, reason } } }
}

/** A scripted Workflow whose match()/run() behavior is supplied directly, for exercising engine.ts orchestration without a real capability adapter or sandbox. */
export function fakeWorkflow(id: string, input: {
  match: (ctx: MatchContext) => MatchDecision | Promise<MatchDecision>
  run?: (ctx: RunContext) => Promise<WorkflowRunResult | void>
}): Workflow {
  return { id, match: input.match, run: input.run ?? (async () => ({ summary: "ok" })) }
}

export function fakeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: "evt-1",
    provider: "fake",
    source: "poll",
    provenance: "synthetic",
    kind: "label_added",
    workTarget: { provider: "fake", repo: "acme/widgets", kind: "issue", id: "1" },
    occurredAt: "2026-01-01T00:00:00.000Z",
    observedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  }
}
