import type { CodeReviewHost, WorkReader } from "../../core/capabilities.js"
import type { WorkTargetRef } from "../../core/types.js"
import { git } from "./git.js"
import { asArray, asOptionalString, asRecord, asString } from "./schema.js"

export interface InlineComment { readonly path: string; readonly line: number; readonly body: string }
export interface ThreadReply { readonly threadId: string; readonly body: string }
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
  return { threadId: asString(record.threadId ?? record.commentId, "reply threadId"), body: asString(record.body ?? record.comment, "reply body") }
}

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
  replies.filter(reply => validReplyIds.has(reply.threadId))

/**
 * Builds the review/update-branch prompt context for a change request (GitHub PR
 * or GitLab MR) using only forge-agnostic capabilities — no provider-specific CLI.
 */
export async function fetchChangeRequestContext(input: {
  target: WorkTargetRef
  workReader: WorkReader
  codeReviewHost: CodeReviewHost
  cwd?: string
}): Promise<{
  prTitle: string
  issueNumber: string
  issueTitle: string
  linkedIssue: string
  targetBranch: string
  diff: string
  prCommentsJson: string
  diffLines: Map<string, Set<number>>
  validReplyIds: Set<string>
}> {
  const { target, workReader, codeReviewHost, cwd } = input
  const details = await codeReviewHost.getChangeRequestDetails(target)

  const issueNumber = details.linkedIssueId ?? ""
  const issueTarget: WorkTargetRef = { provider: target.provider, repo: target.repo, project: target.project, kind: "issue", id: issueNumber }
  const issueSnapshot = issueNumber ? await workReader.getTarget(issueTarget).catch(() => undefined) : undefined
  const issueComments = issueNumber ? await codeReviewHost.listGeneralComments(issueTarget).catch(() => []) : []
  const linkedIssue = issueSnapshot
    ? [`# ${issueSnapshot.title}\n\n${issueSnapshot.body ?? ""}`, ...issueComments.map(c => `---\n${c.author ?? "unknown"}: ${c.body}`)].join("\n\n")
    : "(no linked issue found)"

  const generalComments = await codeReviewHost.listGeneralComments(target)
  const reviewThreads = await codeReviewHost.listReviewThreads(target)

  const prComments = {
    comments: generalComments.map(c => ({ author: c.author ?? "unknown", body: c.body, createdAt: c.createdAt })),
    review_threads: reviewThreads.map(t => ({ id: t.id, path: t.path, line: t.line, comments: t.comments.map(c => ({ author: c.author ?? "unknown", body: c.body })) })),
  }

  const diff = await git(["diff", `origin/${details.targetBranch}...HEAD`], { cwd }).catch(() => git(["diff", `origin/${details.targetBranch}..HEAD`], { cwd }))

  return {
    prTitle: details.title,
    issueNumber,
    issueTitle: issueSnapshot?.title ?? "",
    linkedIssue,
    targetBranch: details.targetBranch,
    diff,
    prCommentsJson: JSON.stringify(prComments, null, 2),
    diffLines: parseDiffLines(diff),
    validReplyIds: new Set(reviewThreads.map(t => t.id)),
  }
}
