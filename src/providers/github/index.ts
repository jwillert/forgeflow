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
  WorkTargetRef,
  WorkTargetSnapshot,
} from "../../core/types.js"

export type GitHubOptions = { token: string; apiUrl?: string }

export function github(options: GitHubOptions) {
  const api = new GitHubApi(options)
  return {
    repo(name: string, config: { workflows: import("../../core/workflow.js").Workflow[]; baseBranch?: string }) {
      const adapter = new GitHubRepoAdapter(api, name, config.baseBranch)
      return {
        provider: "github",
        id: name,
        codeRepo: name,
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

class GitHubApi {
  private base: string
  constructor(private options: GitHubOptions) { this.base = options.apiUrl ?? "https://api.github.com" }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${this.options.token}`,
        "x-github-api-version": "2022-11-28",
        ...(init.headers ?? {}),
      },
    })
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`)
    if (res.status === 204) return undefined as T
    return await res.json() as T
  }
}

type GhIssue = { number: number; title: string; body?: string; labels: Array<{ name: string }>; user?: { id: number; login: string }; html_url: string; updated_at: string; pull_request?: unknown }
type GhComment = { id: number; body: string; html_url: string; created_at: string; user?: { id: number; login: string } }
type GhPullRequest = {
  number: number
  node_id: string
  html_url: string
  title: string
  body?: string | null
  head: { ref: string; sha: string; repo?: { full_name: string } | null }
  base: { ref: string }
}
type GhReview = { user?: { login: string } | null; body?: string | null; submitted_at?: string | null }
type GraphQlThreadNode = {
  id: string
  isResolved: boolean
  comments: { nodes: Array<{ id: string; databaseId: number; path?: string; line?: number; originalLine?: number; body: string; author?: { login: string } | null }> }
}

const linkedIssueId = (body?: string | null): string | undefined => body?.match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1]

class GitHubRepoAdapter implements PollingEventSource, WorkTracker, CodeHost, CodeReviewHost {
  readonly provider = "github"
  readonly targetId: string
  constructor(private api: GitHubApi, private repo: string, private baseBranch?: string) { this.targetId = repo }
  private get ownerRepo() { const [owner, repo] = this.repo.split("/"); return { owner, repo } }

  async poll(input: { cursor?: { value?: string }; maxEvents: number }) {
    const since = input.cursor?.value
    const q = new URLSearchParams({ state: "open", per_page: String(Math.min(input.maxEvents, 100)), sort: "updated", direction: "asc" })
    if (since) q.set("since", since)
    const issues = await this.api.request<GhIssue[]>(`/repos/${this.repo}/issues?${q}`)
    const now = new Date().toISOString()
    const events: NormalizedEvent[] = []
    for (const issue of issues) {
      for (const label of issue.labels) {
        if (!label.name.startsWith("agent:")) continue
        events.push({
          id: `github:${this.repo}:${issue.pull_request ? "pull_request" : "issue"}:${issue.number}:label:${label.name}:${issue.updated_at}`,
          provider: "github",
          source: "poll",
          provenance: "synthetic",
          kind: "label_added",
          workTarget: { provider: "github", repo: this.repo, kind: issue.pull_request ? "pull_request" : "issue", id: String(issue.number), url: issue.html_url },
          actor: issue.user ? { provider: "github", id: String(issue.user.id), login: issue.user.login } : undefined,
          label: label.name,
          occurredAt: issue.updated_at,
          observedAt: now,
        })
      }
      if (events.length >= input.maxEvents) break
      const comments = await this.api.request<GhComment[]>(`/repos/${this.repo}/issues/${issue.number}/comments?per_page=20`)
      for (const comment of comments) {
        if (comment.body.trim() !== "/agent retry") continue
        events.push({
          id: `github:${this.repo}:${issue.pull_request ? "pull_request" : "issue"}:${issue.number}:comment:${comment.id}`,
          provider: "github",
          source: "poll",
          provenance: "historical",
          kind: "comment_created",
          workTarget: { provider: "github", repo: this.repo, kind: issue.pull_request ? "pull_request" : "issue", id: String(issue.number), url: issue.html_url },
          actor: comment.user ? { provider: "github", id: String(comment.user.id), login: comment.user.login } : undefined,
          comment: { id: String(comment.id), body: comment.body, url: comment.html_url },
          occurredAt: comment.created_at,
          observedAt: now,
        })
        if (events.length >= input.maxEvents) break
      }
      if (events.length >= input.maxEvents) break
    }
    const last = issues.at(-1)?.updated_at
    return { events, nextCursor: { value: last ?? since ?? now } }
  }

  async getTarget(target: WorkTargetRef): Promise<WorkTargetSnapshot> {
    const issue = await this.api.request<GhIssue>(`/repos/${this.repo}/issues/${target.id}`)
    return {
      target,
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map(l => l.name),
      author: issue.user ? { provider: "github", id: String(issue.user.id), login: issue.user.login } : undefined,
      url: issue.html_url,
      updatedAt: issue.updated_at,
    }
  }

  async addLabel(target: WorkTargetRef, label: string) {
    await this.api.request(`/repos/${this.repo}/issues/${target.id}/labels`, { method: "POST", body: JSON.stringify({ labels: [label] }) })
  }
  async removeLabel(target: WorkTargetRef, label: string) {
    await this.api.request(`/repos/${this.repo}/issues/${target.id}/labels/${encodeURIComponent(label)}`, { method: "DELETE" })
  }
  async addComment(target: WorkTargetRef, body: string) {
    const c = await this.api.request<{ id: number; html_url: string }>(`/repos/${this.repo}/issues/${target.id}/comments`, { method: "POST", body: JSON.stringify({ body }) })
    return { id: String(c.id), url: c.html_url }
  }

  async resolveCheckout(target: CodeTargetRef, command: AgentCommand): Promise<CheckoutSpec> {
    const repo = await this.api.request<{ clone_url: string; default_branch: string }>(`/repos/${target.repo}`)
    return { cloneUrl: repo.clone_url, baseRef: target.baseBranch ?? this.baseBranch ?? repo.default_branch, workBranch: defaultWorkBranch(command), authRef: `github:${target.repo}:write` }
  }

  async openOrUpdateChangeRequest(input: { existing?: ChangeRequestRef; sourceBranch: BranchRef; targetBranch: string; title: string; body: string }): Promise<ChangeRequestRef> {
    if (input.existing) {
      const pr = await this.api.request<{ number: number; html_url: string }>(`/repos/${this.repo}/pulls/${input.existing.id}`, { method: "PATCH", body: JSON.stringify({ title: input.title, body: input.body }) })
      return { provider: "github", id: String(pr.number), url: pr.html_url, kind: "pull_request" }
    }
    const pr = await this.api.request<{ number: number; html_url: string }>(`/repos/${this.repo}/pulls`, { method: "POST", body: JSON.stringify({ title: input.title, body: input.body, head: input.sourceBranch.name, base: input.targetBranch }) })
    return { provider: "github", id: String(pr.number), url: pr.html_url, kind: "pull_request" }
  }

  async getChangeRequestDetails(target: WorkTargetRef): Promise<ChangeRequestDetails> {
    const pr = await this.api.request<GhPullRequest>(`/repos/${this.repo}/pulls/${target.id}`)
    return {
      sourceBranch: pr.head.ref,
      sourceSha: pr.head.sha,
      targetBranch: pr.base.ref,
      title: pr.title,
      isCrossRepository: pr.head.repo?.full_name !== this.repo,
      linkedIssueId: linkedIssueId(pr.body),
    }
  }

  async listGeneralComments(target: WorkTargetRef): Promise<GeneralComment[]> {
    const comments = await this.api.request<GhComment[]>(`/repos/${this.repo}/issues/${target.id}/comments?per_page=100`)
    const general: GeneralComment[] = comments.map(c => ({ author: c.user?.login, body: c.body, createdAt: c.created_at }))
    if (target.kind !== "pull_request") return general
    const reviews = await this.api.request<GhReview[]>(`/repos/${this.repo}/pulls/${target.id}/reviews`)
    const reviewSummaries = reviews
      .filter(r => r.body && r.body.trim().length > 0)
      .map(r => ({ author: r.user?.login, body: r.body as string, createdAt: r.submitted_at ?? undefined }))
    return [...general, ...reviewSummaries]
  }

  async listReviewThreads(target: WorkTargetRef): Promise<ReviewThread[]> {
    if (target.kind !== "pull_request") return []
    const { owner, repo } = this.ownerRepo
    const query = `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ pullRequest(number:$number){ reviewThreads(first:100){ nodes{ id isResolved comments(first:50){ nodes{ id databaseId path line originalLine body author{ login } } } } } } } }`
    const result = await this.graphql<{ repository: { pullRequest: { reviewThreads: { nodes: GraphQlThreadNode[] } } } }>(query, { owner, repo, number: Number(target.id) })
    return result.repository.pullRequest.reviewThreads.nodes
      .filter(thread => !thread.isResolved)
      .map(thread => ({
        id: thread.id,
        path: thread.comments.nodes[0]?.path,
        line: thread.comments.nodes[0]?.line ?? thread.comments.nodes[0]?.originalLine,
        isResolved: thread.isResolved,
        comments: thread.comments.nodes.map(c => ({ id: c.id, author: c.author?.login, body: c.body })),
      }))
  }

  async postReview(target: WorkTargetRef, input: { commitSha: string; summary: string; inlineComments: InlineReviewComment[] }): Promise<void> {
    await this.api.request(`/repos/${this.repo}/pulls/${target.id}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        commit_id: input.commitSha,
        event: "COMMENT",
        body: input.summary,
        comments: input.inlineComments.map(c => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
      }),
    })
  }

  async replyToThread(target: WorkTargetRef, input: { threadId: string; body: string }): Promise<void> {
    const { owner, repo } = this.ownerRepo
    const query = `query($id:ID!){ node(id:$id){ ... on PullRequestReviewThread { comments(last:1){ nodes{ databaseId } } } } }`
    const result = await this.graphql<{ node?: { comments?: { nodes: Array<{ databaseId: number }> } } }>(query, { id: input.threadId })
    const databaseId = result.node?.comments?.nodes[0]?.databaseId
    if (!databaseId) throw new Error(`Could not resolve a replyable comment for thread ${input.threadId}`)
    await this.api.request(`/repos/${owner}/${repo}/pulls/${target.id}/comments/${databaseId}/replies`, { method: "POST", body: JSON.stringify({ body: input.body }) })
  }

  async markReady(target: WorkTargetRef): Promise<void> {
    const pr = await this.api.request<GhPullRequest>(`/repos/${this.repo}/pulls/${target.id}`)
    await this.graphql(`mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ clientMutationId } }`, { id: pr.node_id })
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const result = await this.api.request<{ data?: T; errors?: Array<{ message: string }> }>("/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    })
    if (result.errors?.length) throw new Error(`GitHub GraphQL error: ${result.errors.map(e => e.message).join("; ")}`)
    if (!result.data) throw new Error("GitHub GraphQL response had no data")
    return result.data
  }
}
