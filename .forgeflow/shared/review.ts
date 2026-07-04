import { gh, ghApiJson, ghJson } from "./github.js"
import { git } from "./git.js"
import { asArray, asOptionalString, asRecord, asString, standardSchema } from "./schema.js"

export interface InlineComment { readonly path: string; readonly line: number; readonly body: string }
export interface ThreadReply { readonly commentId: string; readonly body: string }
export interface ReviewOutput { readonly summary: string; readonly inlineComments: InlineComment[]; readonly replies: ThreadReply[] }
export interface UpdateBranchOutput { readonly comment: string }

const parseLine = (value: unknown, record: Record<string, unknown>): number => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  const firstLine = asOptionalString(record.lineRange)?.match(/\d+/)?.[0]
  if (firstLine) return Number(firstLine)
  throw new Error("line must be a positive integer or lineRange must start with a line number")
}

const parseInlineComment = (value: unknown): InlineComment => {
  const record = asRecord(value, "inline comment")
  return {
    path: asString(record.path ?? record.file, "inline comment path"),
    line: parseLine(record.line, record),
    body: asString(record.body ?? record.comment, "inline comment body"),
  }
}

const parseReply = (value: unknown): ThreadReply => {
  const record = asRecord(value, "reply")
  return { commentId: asString(record.commentId, "reply commentId"), body: asString(record.body ?? record.comment, "reply body") }
}

export const reviewOutputSchema = standardSchema<ReviewOutput>((value) => {
  const record = asRecord(value, "review output")
  return {
    summary: asString(record.summary, "summary"),
    inlineComments: asArray(record.inlineComments ?? [], "inlineComments").map(parseInlineComment),
    replies: asArray(record.replies ?? [], "replies").map(parseReply),
  }
})

export const updateBranchOutputSchema = standardSchema<UpdateBranchOutput>((value) => {
  const record = asRecord(value, "update-branch output")
  return { comment: asString(record.comment, "comment") }
})

export function validateReviewOutput(value: unknown): ReviewOutput {
  const record = asRecord(value, "review output")
  return {
    summary: asString(record.summary, "summary"),
    inlineComments: asArray(record.inlineComments ?? [], "inlineComments").map(parseInlineComment),
    replies: asArray(record.replies ?? [], "replies").map(parseReply),
  }
}

export function validateUpdateBranchOutput(value: unknown): UpdateBranchOutput {
  const record = asRecord(value, "update-branch output")
  return { comment: asString(record.comment, "comment") }
}

export function parseDiffLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>()
  let currentFile: string | undefined
  let newLine = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length)
      if (!files.has(currentFile)) files.set(currentFile, new Set())
      continue
    }
    if (!currentFile) continue
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) { newLine = Number(hunk[1]); continue }
    if (line.startsWith("+") && !line.startsWith("+++")) { files.get(currentFile)?.add(newLine); newLine++; continue }
    if (line.startsWith(" ") || line === "") { files.get(currentFile)?.add(newLine); newLine++ }
  }
  return files
}

export const filterInlineComments = (comments: readonly InlineComment[], diffLines: Map<string, Set<number>>): InlineComment[] =>
  comments.filter(comment => diffLines.get(comment.path)?.has(comment.line) ?? false)

export const filterReplies = (replies: readonly ThreadReply[], validReplyIds: Set<string>): ThreadReply[] =>
  replies.filter(reply => validReplyIds.has(reply.commentId))

export async function fetchPullRequestContext(prNumber: string, options: { cwd?: string } = {}): Promise<{
  prTitle: string
  issueNumber: string
  issueTitle: string
  linkedIssue: string
  diff: string
  prCommentsJson: string
  diffLines: Map<string, Set<number>>
  validReplyIds: Set<string>
}> {
  const prView = await ghJson<{ title: string; body?: string | null; comments: { author?: { login: string } | null; body: string; createdAt?: string }[] }>(["pr", "view", prNumber, "--json", "title,body,comments"])
  const issueNumber = prView.body?.match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1] ?? ""
  const issueTitle = issueNumber ? await gh(["issue", "view", issueNumber, "--json", "title", "--jq", ".title"]).catch(() => "") : ""
  const linkedIssue = issueNumber ? await gh(["issue", "view", issueNumber, "--comments"]).catch(() => "") : "(no linked issue found)"
  const reviews = await ghApiJson<{ user?: { login: string } | null; body?: string | null; state: string; submitted_at?: string | null }[]>(`repos/{owner}/{repo}/pulls/${prNumber}/reviews`)

  const [owner, repo] = (process.env.GH_REPO ?? "").split("/")
  const query = `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ pullRequest(number:$number){ reviewThreads(first:100){ nodes{ id isResolved comments(first:50){ nodes{ id path line originalLine body author{ login } } } } } } } }`
  const threadsParsed = await ghJson<any>(["api", "graphql", "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `number=${prNumber}`, "-f", `query=${query}`])
  const threads = threadsParsed.data?.repository?.pullRequest?.reviewThreads?.nodes?.filter((thread: any) => !thread.isResolved) ?? []
  const reviewThreads = threads.flatMap((thread: any) => thread.comments.nodes.map((comment: any) => ({
    commentId: comment.id,
    threadId: thread.id,
    path: comment.path,
    line: comment.line ?? comment.originalLine,
    author: comment.author?.login ?? "unknown",
    body: comment.body,
  })))

  const prComments = {
    issue_comments: prView.comments.map(comment => ({ author: comment.author?.login ?? "unknown", body: comment.body, createdAt: comment.createdAt })),
    review_summaries: reviews.filter(review => review.body && review.body.trim().length > 0).map(review => ({ author: review.user?.login ?? "unknown", state: review.state, body: review.body, submittedAt: review.submitted_at })),
    review_threads: reviewThreads,
  }
  const diff = await git(["diff", "main...HEAD"], { cwd: options.cwd }).catch(() => git(["diff", "main..HEAD"], { cwd: options.cwd }))
  return { prTitle: prView.title, issueNumber, issueTitle, linkedIssue, diff, prCommentsJson: JSON.stringify(prComments, null, 2), diffLines: parseDiffLines(diff), validReplyIds: new Set(reviewThreads.map((comment: any) => comment.commentId)) }
}
