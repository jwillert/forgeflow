import type { AgentCommand, CodeTargetRef, NormalizedEvent, TargetKind } from "./types.js"
import type { CapabilityRegistry, CodeReader, CodeHost, CodeReviewHost, CommandState, TrustPolicy, WorkReader, WorkTracker } from "./capabilities.js"

export type MatchDecision =
  | { type: "ignore" }
  | { type: "reject"; reason: string }
  | { type: "defer"; reason: string; nextCheckAt?: string }
  | { type: "accept"; title?: string; body?: string }

export const Match = {
  ignore(): MatchDecision { return { type: "ignore" } },
  reject(reason: string): MatchDecision { return { type: "reject", reason } },
  defer(input: string | { reason: string; nextCheckAt?: Date | string }): MatchDecision {
    if (typeof input === "string") return { type: "defer", reason: input }
    return { type: "defer", reason: input.reason, nextCheckAt: input.nextCheckAt instanceof Date ? input.nextCheckAt.toISOString() : input.nextCheckAt }
  },
  accept(input: { title?: string; body?: string } = {}): MatchDecision { return { type: "accept", ...input } },
}

export type MatchContext = {
  event: NormalizedEvent
  workReader: WorkReader
  codeReader: CodeReader
  state: GatewayReadState
  trustPolicy: TrustPolicy
}

export type RunContext = {
  command: AgentCommand
  workReader: WorkReader
  workTracker: WorkTracker
  codeHost: CodeHost
  codeReviewHost: CodeReviewHost
  commandState: CommandState
  capabilities: CapabilityRegistry
}

export type WorkflowRunResult = { summary?: string; outputs?: Record<string, unknown> }

export type Workflow = {
  id: string
  match(ctx: MatchContext): Promise<MatchDecision> | MatchDecision
  run(ctx: RunContext): Promise<WorkflowRunResult | void>
}

export function defineWorkflow(id: string, workflow: Omit<Workflow, "id">): Workflow {
  return { id, ...workflow }
}

export interface GatewayReadState {
  hasCommand(commandId: string): Promise<boolean>
}

export function labelAdded(event: NormalizedEvent, label: string): boolean {
  return event.kind === "label_added" && event.label === label
}

/** True for any "PR-like" target kind — GitHub pull requests and GitLab merge requests alike. */
export function isChangeRequestKind(kind: TargetKind): boolean {
  return kind === "pull_request" || kind === "merge_request"
}

/** True when a new tag was pushed, optionally filtered to tag names matching `pattern` (e.g. /^v/). */
export function tagCreated(event: NormalizedEvent, pattern?: RegExp): boolean {
  if (event.kind !== "tag_created" || !event.tag) return false
  return pattern ? pattern.test(event.tag) : true
}

export function defaultCommandId(input: { event: NormalizedEvent; workflowId: string }): string {
  const t = input.event.workTarget
  const trigger = input.event.kind === "label_added" ? `label:${input.event.label}` : input.event.kind
  return `${t.provider}:${t.repo ?? t.project ?? "target"}:${t.kind}:${t.id}:${input.workflowId}:${trigger}`
}

export function defaultWorkBranch(command: Pick<AgentCommand, "workflowId" | "workTarget">): string {
  return `agent/${command.workflowId}/${command.workTarget.kind}-${command.workTarget.id}`.replace(/[^A-Za-z0-9/_-]/g, "-")
}

export function codeTargetFromEnabledTarget(target: { provider: string; codeRepo: string; baseBranch?: string }): CodeTargetRef {
  return { provider: target.provider, repo: target.codeRepo, baseBranch: target.baseBranch }
}
