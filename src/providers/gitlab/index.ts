import { defaultWorkBranch } from "../../core/workflow.js"
import type { CodeHost, CodeReviewHost, PollingEventSource, WorkTracker } from "../../core/capabilities.js"
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
  TargetKind,
  WorkTargetRef,
  WorkTargetSnapshot,
} from "../../core/types.js"

export type GitLabOptions = { token: string; baseUrl?: string }

export function gitlab(options: GitLabOptions) {
  const api = new GitLabApi(options)
  return {
    project(path: string, config: { workflows: import("../../core/workflow.js").Workflow[]; baseBranch?: string }) {
      const adapter = new GitLabProjectAdapter(api, path, config.baseBranch)
      return {
        provider: "gitlab",
        id: path,
        codeRepo: path,
        baseBranch: config.baseBranch,
        workflows: config.workflows,
        pollingSource: adapter,
        workReader: adapter,
        workTracker: adapter,
        codeReader: adapter,
        codeHost: adapter,
        codeReviewHost: adapter,
      }
    },
  }
}

class GitLabApi {
  private base: string
  constructor(private options: GitLabOptions) { this.base = (options.baseUrl ?? "https://gitlab.com").replace(/\/$/, "") + "/api/v4" }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { ...init, headers: { "PRIVATE-TOKEN": this.options.token, "content-type": "application/json", ...(init.headers ?? {}) } })
    if (!res.ok) throw new Error(`GitLab ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`)
    if (res.status === 204) return undefined as T
    return await res.json() as T
  }
}

type GlIssue = { iid: number; title: string; description?: string; labels: string[]; author?: { id: number; username: string }; web_url: string; updated_at: string; state: "opened" | "closed" }
type GlNote = { id: number; body: string; created_at: string; author?: { id: number; username: string }; system?: boolean }
type GlMergeRequest = {
  iid: number
  title: string
  description?: string | null
  labels: string[]
  author?: { id: number; username: string }
  web_url: string
  updated_at: string
  state: "opened" | "closed" | "merged" | "locked"
  source_branch: string
  target_branch: string
  sha: string
  source_project_id: number
  target_project_id: number
  diff_refs?: { base_sha: string; start_sha: string; head_sha: string }
}
type GlDiscussionNote = { id: number; body: string; system?: boolean; resolvable?: boolean; resolved?: boolean; author?: { username: string } }
type GlDiscussion = { id: string; notes: GlDiscussionNote[] }
type GlIssueLink = { iid: number; link_type: "relates_to" | "blocks" | "is_blocked_by" }

const linkedIssueId = (body?: string | null): string | undefined => body?.match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1]

const parseBlockedByIds = (body?: string | null): string[] =>
  Array.from(body?.matchAll(/(?:blocked by|depends on)\s+#(\d+)/gi) ?? [], m => m[1])

const noteScope = (kind: TargetKind): "issues" | "merge_requests" => kind === "merge_request" ? "merge_requests" : "issues"

const normalizeState = (state: "opened" | "closed" | "merged" | "locked"): "open" | "closed" => state === "opened" ? "open" : "closed"

class GitLabProjectAdapter implements PollingEventSource, WorkTracker, CodeHost, CodeReviewHost {
  readonly provider = "gitlab"
  readonly targetId: string
  private encoded: string
  constructor(private api: GitLabApi, private project: string, private baseBranch?: string) { this.targetId = project; this.encoded = encodeURIComponent(project) }

  async poll(input: { cursor?: { value?: string }; maxEvents: number }) {
    const now = new Date().toISOString()
    const events: NormalizedEvent[] = []
    let latestUpdatedAt: string | undefined

    const collect = async (kind: TargetKind, items: Array<{ iid: number; labels: string[]; web_url: string; updated_at: string; author?: { id: number; username: string } }>) => {
      for (const item of items) {
        if (!latestUpdatedAt || item.updated_at > latestUpdatedAt) latestUpdatedAt = item.updated_at
        for (const label of item.labels) {
          if (!label.startsWith("agent:")) continue
          events.push({
            id: `gitlab:${this.project}:${kind}:${item.iid}:label:${label}:${item.updated_at}`,
            provider: "gitlab",
            source: "poll",
            provenance: "synthetic",
            kind: "label_added",
            workTarget: { provider: "gitlab", project: this.project, repo: this.project, kind, id: String(item.iid), url: item.web_url },
            actor: item.author ? { provider: "gitlab", id: String(item.author.id), login: item.author.username } : undefined,
            label,
            occurredAt: item.updated_at,
            observedAt: now,
          })
        }
        if (events.length >= input.maxEvents) return
        const notes = await this.api.request<GlNote[]>(`/projects/${this.encoded}/${noteScope(kind)}/${item.iid}/notes?per_page=20`)
        for (const note of notes) {
          if (note.body.trim() !== "/agent retry") continue
          events.push({
            id: `gitlab:${this.project}:${kind}:${item.iid}:comment:${note.id}`,
            provider: "gitlab",
            source: "poll",
            provenance: "historical",
            kind: "comment_created",
            workTarget: { provider: "gitlab", project: this.project, repo: this.project, kind, id: String(item.iid), url: item.web_url },
            actor: note.author ? { provider: "gitlab", id: String(note.author.id), login: note.author.username } : undefined,
            comment: { id: String(note.id), body: note.body },
            occurredAt: note.created_at,
            observedAt: now,
          })
          if (events.length >= input.maxEvents) return
        }
        if (events.length >= input.maxEvents) return
      }
    }

    const q = new URLSearchParams({ state: "opened", per_page: String(Math.min(input.maxEvents, 100)), order_by: "updated_at", sort: "asc" })
    if (input.cursor?.value) q.set("updated_after", input.cursor.value)

    const issues = await this.api.request<GlIssue[]>(`/projects/${this.encoded}/issues?${q}`)
    await collect("issue", issues)
    if (events.length < input.maxEvents) {
      const mergeRequests = await this.api.request<GlMergeRequest[]>(`/projects/${this.encoded}/merge_requests?${q}`)
      await collect("merge_request", mergeRequests)
    }

    return { events, nextCursor: { value: latestUpdatedAt ?? input.cursor?.value ?? now } }
  }

  async getTarget(target: WorkTargetRef): Promise<WorkTargetSnapshot> {
    if (target.kind === "merge_request") {
      const mr = await this.api.request<GlMergeRequest>(`/projects/${this.encoded}/merge_requests/${target.id}`)
      return { target, title: mr.title, body: mr.description ?? undefined, labels: mr.labels, author: mr.author ? { provider: "gitlab", id: String(mr.author.id), login: mr.author.username } : undefined, url: mr.web_url, updatedAt: mr.updated_at, state: normalizeState(mr.state) }
    }
    const issue = await this.api.request<GlIssue>(`/projects/${this.encoded}/issues/${target.id}`)
    return { target, title: issue.title, body: issue.description, labels: issue.labels, author: issue.author ? { provider: "gitlab", id: String(issue.author.id), login: issue.author.username } : undefined, url: issue.web_url, updatedAt: issue.updated_at, state: normalizeState(issue.state) }
  }

  async listBlockingIssues(target: WorkTargetRef): Promise<WorkTargetRef[]> {
    const snapshot = await this.getTarget(target).catch(() => undefined)
    const textBlocked = parseBlockedByIds(snapshot?.body)

    let nativeBlocked: string[] = []
    if (target.kind !== "merge_request") {
      const links = await this.api.request<GlIssueLink[]>(`/projects/${this.encoded}/issues/${target.id}/links`).catch(() => [])
      nativeBlocked = links.filter(l => l.link_type === "is_blocked_by").map(l => String(l.iid))
    }

    const ids = new Set([...textBlocked, ...nativeBlocked])
    return [...ids].map(id => ({ provider: "gitlab", project: this.project, repo: this.project, kind: "issue" as const, id }))
  }

  async addLabel(target: WorkTargetRef, label: string) {
    const snapshot = await this.getTarget(target)
    const labels = Array.from(new Set([...snapshot.labels, label])).join(",")
    await this.api.request(`/projects/${this.encoded}/${noteScope(target.kind)}/${target.id}`, { method: "PUT", body: JSON.stringify({ labels }) })
  }
  async removeLabel(target: WorkTargetRef, label: string) {
    await this.api.request(`/projects/${this.encoded}/${noteScope(target.kind)}/${target.id}`, { method: "PUT", body: JSON.stringify({ remove_labels: label }) })
  }
  async addComment(target: WorkTargetRef, body: string) {
    const note = await this.api.request<{ id: number; body: string }>(`/projects/${this.encoded}/${noteScope(target.kind)}/${target.id}/notes`, { method: "POST", body: JSON.stringify({ body }) })
    return { id: String(note.id) }
  }

  async resolveCheckout(target: CodeTargetRef, command: AgentCommand): Promise<CheckoutSpec> {
    const project = await this.api.request<{ http_url_to_repo: string; default_branch: string }>(`/projects/${encodeURIComponent(target.repo)}`)
    return { cloneUrl: project.http_url_to_repo, baseRef: target.baseBranch ?? this.baseBranch ?? project.default_branch, workBranch: defaultWorkBranch(command), authRef: `gitlab:${target.repo}:write` }
  }

  async openOrUpdateChangeRequest(input: { existing?: ChangeRequestRef; sourceBranch: BranchRef; targetBranch: string; title: string; body: string }): Promise<ChangeRequestRef> {
    if (input.existing) {
      const mr = await this.api.request<{ iid: number; web_url: string }>(`/projects/${this.encoded}/merge_requests/${input.existing.id}`, { method: "PUT", body: JSON.stringify({ title: input.title, description: input.body }) })
      return { provider: "gitlab", id: String(mr.iid), url: mr.web_url, kind: "merge_request" }
    }
    const mr = await this.api.request<{ iid: number; web_url: string }>(`/projects/${this.encoded}/merge_requests`, { method: "POST", body: JSON.stringify({ title: input.title, description: input.body, source_branch: input.sourceBranch.name, target_branch: input.targetBranch }) })
    return { provider: "gitlab", id: String(mr.iid), url: mr.web_url, kind: "merge_request" }
  }

  async getChangeRequestDetails(target: WorkTargetRef): Promise<ChangeRequestDetails> {
    const mr = await this.api.request<GlMergeRequest>(`/projects/${this.encoded}/merge_requests/${target.id}`)
    return {
      sourceBranch: mr.source_branch,
      sourceSha: mr.sha,
      targetBranch: mr.target_branch,
      title: mr.title,
      isCrossRepository: mr.source_project_id !== mr.target_project_id,
      linkedIssueId: linkedIssueId(mr.description),
    }
  }

  async listGeneralComments(target: WorkTargetRef): Promise<GeneralComment[]> {
    const notes = await this.api.request<GlNote[]>(`/projects/${this.encoded}/${noteScope(target.kind)}/${target.id}/notes?per_page=100`)
    return notes.filter(n => !n.system).map(n => ({ author: n.author?.username, body: n.body, createdAt: n.created_at }))
  }

  async listReviewThreads(target: WorkTargetRef): Promise<ReviewThread[]> {
    if (target.kind !== "merge_request") return []
    const discussions = await this.api.request<GlDiscussion[]>(`/projects/${this.encoded}/merge_requests/${target.id}/discussions?per_page=100`)
    return discussions
      .filter(d => d.notes[0]?.resolvable && !d.notes[0]?.resolved)
      .map(d => ({
        id: d.id,
        isResolved: d.notes[0]?.resolved ?? false,
        comments: d.notes.filter(n => !n.system).map(n => ({ id: String(n.id), author: n.author?.username, body: n.body })),
      }))
  }

  async postReview(target: WorkTargetRef, input: { commitSha: string; summary: string; inlineComments: InlineReviewComment[] }): Promise<void> {
    if (input.summary.trim()) {
      await this.api.request(`/projects/${this.encoded}/merge_requests/${target.id}/notes`, { method: "POST", body: JSON.stringify({ body: input.summary }) })
    }
    if (input.inlineComments.length === 0) return
    const mr = await this.api.request<GlMergeRequest>(`/projects/${this.encoded}/merge_requests/${target.id}`)
    const diffRefs = mr.diff_refs
    if (!diffRefs) throw new Error("GitLab merge request has no diff_refs; cannot post inline comments")
    for (const comment of input.inlineComments) {
      await this.api.request(`/projects/${this.encoded}/merge_requests/${target.id}/discussions`, {
        method: "POST",
        body: JSON.stringify({
          body: comment.body,
          position: {
            position_type: "text",
            base_sha: diffRefs.base_sha,
            start_sha: diffRefs.start_sha,
            head_sha: diffRefs.head_sha,
            new_path: comment.path,
            new_line: comment.line,
          },
        }),
      })
    }
  }

  async replyToThread(target: WorkTargetRef, input: { threadId: string; body: string }): Promise<void> {
    await this.api.request(`/projects/${this.encoded}/merge_requests/${target.id}/discussions/${input.threadId}/notes`, { method: "POST", body: JSON.stringify({ body: input.body }) })
  }

  async markReady(target: WorkTargetRef): Promise<void> {
    const mr = await this.api.request<GlMergeRequest>(`/projects/${this.encoded}/merge_requests/${target.id}`)
    const readyTitle = mr.title.replace(/^\s*(draft:|wip:)\s*/i, "")
    if (readyTitle === mr.title) return
    await this.api.request(`/projects/${this.encoded}/merge_requests/${target.id}`, { method: "PUT", body: JSON.stringify({ title: readyTitle }) })
  }
}
