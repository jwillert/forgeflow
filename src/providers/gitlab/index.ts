import { defaultWorkBranch } from "../../core/workflow.js"
import type { CodeHost, PollingEventSource, WorkTracker } from "../../core/capabilities.js"
import type { AgentCommand, BranchRef, ChangeRequestRef, CheckoutSpec, CodeTargetRef, NormalizedEvent, WorkTargetRef, WorkTargetSnapshot } from "../../core/types.js"

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

type GlIssue = { iid: number; title: string; description?: string; labels: string[]; author?: { id: number; username: string }; web_url: string; updated_at: string }
type GlNote = { id: number; body: string; created_at: string; author?: { id: number; username: string } }

class GitLabProjectAdapter implements PollingEventSource, WorkTracker, CodeHost {
  readonly provider = "gitlab"
  readonly targetId: string
  private encoded: string
  constructor(private api: GitLabApi, private project: string, private baseBranch?: string) { this.targetId = project; this.encoded = encodeURIComponent(project) }

  async poll(input: { cursor?: { value?: string }; maxEvents: number }) {
    const q = new URLSearchParams({ state: "opened", per_page: String(Math.min(input.maxEvents, 100)), order_by: "updated_at", sort: "asc" })
    if (input.cursor?.value) q.set("updated_after", input.cursor.value)
    const issues = await this.api.request<GlIssue[]>(`/projects/${this.encoded}/issues?${q}`)
    const now = new Date().toISOString()
    const events: NormalizedEvent[] = []
    for (const issue of issues) {
      for (const label of issue.labels) {
        if (!label.startsWith("agent:")) continue
        events.push({
          id: `gitlab:${this.project}:issue:${issue.iid}:label:${label}:${issue.updated_at}`,
          provider: "gitlab",
          source: "poll",
          provenance: "synthetic",
          kind: "label_added",
          workTarget: { provider: "gitlab", project: this.project, repo: this.project, kind: "issue", id: String(issue.iid), url: issue.web_url },
          actor: issue.author ? { provider: "gitlab", id: String(issue.author.id), login: issue.author.username } : undefined,
          label,
          occurredAt: issue.updated_at,
          observedAt: now,
        })
      }
      if (events.length >= input.maxEvents) break
      const notes = await this.api.request<GlNote[]>(`/projects/${this.encoded}/issues/${issue.iid}/notes?per_page=20`)
      for (const note of notes) {
        if (note.body.trim() !== "/agent retry") continue
        events.push({
          id: `gitlab:${this.project}:issue:${issue.iid}:comment:${note.id}`,
          provider: "gitlab",
          source: "poll",
          provenance: "historical",
          kind: "comment_created",
          workTarget: { provider: "gitlab", project: this.project, repo: this.project, kind: "issue", id: String(issue.iid), url: issue.web_url },
          actor: note.author ? { provider: "gitlab", id: String(note.author.id), login: note.author.username } : undefined,
          comment: { id: String(note.id), body: note.body },
          occurredAt: note.created_at,
          observedAt: now,
        })
        if (events.length >= input.maxEvents) break
      }
      if (events.length >= input.maxEvents) break
    }
    const last = issues.at(-1)?.updated_at
    return { events, nextCursor: { value: last ?? input.cursor?.value ?? now } }
  }

  async getTarget(target: WorkTargetRef): Promise<WorkTargetSnapshot> {
    const issue = await this.api.request<GlIssue>(`/projects/${this.encoded}/issues/${target.id}`)
    return { target, title: issue.title, body: issue.description, labels: issue.labels, author: issue.author ? { provider: "gitlab", id: String(issue.author.id), login: issue.author.username } : undefined, url: issue.web_url, updatedAt: issue.updated_at }
  }

  async addLabel(target: WorkTargetRef, label: string) {
    const snapshot = await this.getTarget(target)
    const labels = Array.from(new Set([...snapshot.labels, label])).join(",")
    await this.api.request(`/projects/${this.encoded}/issues/${target.id}`, { method: "PUT", body: JSON.stringify({ labels }) })
  }
  async removeLabel(target: WorkTargetRef, label: string) {
    await this.api.request(`/projects/${this.encoded}/issues/${target.id}`, { method: "PUT", body: JSON.stringify({ remove_labels: label }) })
  }
  async addComment(target: WorkTargetRef, body: string) {
    const note = await this.api.request<{ id: number; body: string }>(`/projects/${this.encoded}/issues/${target.id}/notes`, { method: "POST", body: JSON.stringify({ body }) })
    return { id: String(note.id) }
  }

  async resolveCheckout(target: CodeTargetRef, command: AgentCommand): Promise<CheckoutSpec> {
    const project = await this.api.request<{ http_url_to_repo: string; default_branch: string }>(`/projects/${encodeURIComponent(target.repo)}`)
    return { cloneUrl: project.http_url_to_repo, baseRef: target.baseBranch ?? this.baseBranch ?? project.default_branch, workBranch: defaultWorkBranch(command), authRef: `gitlab:${target.repo}:write` }
  }

  async openOrUpdateChangeRequest(input: { existing?: ChangeRequestRef; sourceBranch: BranchRef; targetBranch: string; title: string; body: string }): Promise<ChangeRequestRef> {
    if (input.existing) {
      const mr = await this.api.request<{ iid: number; web_url: string }>(`/projects/${this.encoded}/merge_requests/${input.existing.id}`, { method: "PUT", body: JSON.stringify({ title: input.title, description: input.body }) })
      return { provider: "gitlab", id: String(mr.iid), url: mr.web_url }
    }
    const mr = await this.api.request<{ iid: number; web_url: string }>(`/projects/${this.encoded}/merge_requests`, { method: "POST", body: JSON.stringify({ title: input.title, description: input.body, source_branch: input.sourceBranch.name, target_branch: input.targetBranch }) })
    return { provider: "gitlab", id: String(mr.iid), url: mr.web_url }
  }
}
