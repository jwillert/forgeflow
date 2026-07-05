export type ProviderId = string
export type TargetKind = "issue" | "pull_request" | "merge_request" | "project" | "repo" | "tag"

export type WorkTargetRef = {
  provider: ProviderId
  id: string
  kind: TargetKind
  repo?: string
  project?: string
  url?: string
}

export type CodeTargetRef = {
  provider: ProviderId
  repo: string
  baseBranch?: string
}

export type ActorRef = {
  provider: ProviderId
  id: string
  login: string
}

export type NormalizedEvent = {
  id: string
  provider: ProviderId
  source: "poll" | "webhook"
  provenance: "historical" | "synthetic"
  kind: "label_added" | "label_removed" | "comment_created" | "comment_command" | "target_updated" | "target_opened" | "tag_created"
  workTarget: WorkTargetRef
  actor?: ActorRef
  label?: string
  comment?: { id: string; body: string; url?: string }
  command?: string
  tag?: string
  occurredAt: string
  observedAt: string
  raw?: unknown
}

export type PollCursor = { value?: string }

export type PollBatch = {
  events: NormalizedEvent[]
  nextCursor?: PollCursor
}

export type WorkTargetSnapshot = {
  target: WorkTargetRef
  title?: string
  body?: string
  labels: string[]
  author?: ActorRef
  url?: string
  updatedAt?: string
  state?: "open" | "closed"
}

export type CheckoutSpec = {
  cloneUrl: string
  baseRef: string
  workBranch: string
  authRef: string
}

export type BranchRef = {
  provider: ProviderId
  repo: string
  name: string
  url?: string
}

export type CommentRef = { id: string; url?: string }

export type ChangeRequestRef = {
  provider: ProviderId
  id: string
  url?: string
  kind: TargetKind
}

export type ChangeRequestDetails = {
  sourceBranch: string
  sourceSha: string
  targetBranch: string
  title: string
  isCrossRepository: boolean
  linkedIssueId?: string
}

export type GeneralComment = {
  author?: string
  body: string
  createdAt?: string
}

export type ReviewThreadComment = {
  id: string
  author?: string
  body: string
}

export type ReviewThread = {
  id: string
  path?: string
  line?: number
  isResolved: boolean
  comments: ReviewThreadComment[]
}

export type InlineReviewComment = {
  path: string
  line: number
  body: string
}

export type ExecutionResult =
  | {
      status: "success"
      mode: "pushed_branch"
      summary: string
      branch: BranchRef
      commitSha?: string
      logsUrl?: string
      artifacts?: Array<{ name: string; url: string }>
    }
  | {
      status: "failed"
      summary: string
      logsUrl?: string
      error?: string
    }

export type AgentCommandStatus = "queued" | "deferred" | "running" | "succeeded" | "failed" | "rejected"

export type AgentCommand = {
  id: string
  workflowId: string
  triggerEvent: NormalizedEvent
  workTarget: WorkTargetRef
  codeTarget: CodeTargetRef
  title: string
  body?: string
  status: AgentCommandStatus
  deferReason?: string
  nextCheckAt?: string
  createdAt: string
  updatedAt: string
}
