import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { defineWorkflow, labelAdded, Match } from "forgeflow"
import { git, pushBranch } from "../shared/git.js"
import { addPrLabel, commentPr, gh, ghJson, removePrLabel } from "../shared/github.js"
import { optionalEnv } from "../shared/shell.js"
import { createPodmanSandbox, runSandboxWithExtraction } from "../shared/sandcastle.js"
import { fetchPullRequestContext, filterInlineComments, filterReplies, validateReviewOutput } from "../shared/review.js"

const here = dirname(fileURLToPath(import.meta.url))
const promptFile = join(here, "../prompts/review/prompt.md")
const extractionPrompt = await import("node:fs").then(fs => fs.readFileSync(join(here, "../prompts/review/extraction.md"), "utf8"))

export const review = defineWorkflow("review", {
  match: ({ event }) => {
    if (!labelAdded(event, "agent:review")) return Match.ignore()
    if (event.workTarget.kind !== "pull_request") return Match.ignore()
    return Match.accept()
  },

  run: async ({ command, workTracker }) => {
    const prNumber = command.workTarget.id
    const outputDir = optionalEnv("FORGEFLOW_OUTPUT_DIR", "/tmp/forgeflow-output")

    const markFailed = async (message: string) => {
      await workTracker.addLabel(command.workTarget, "agent:blocked").catch(() => undefined)
      await workTracker.addComment(command.workTarget, `\`agent:review\` run failed.\n\n**Reason:** ${message}\n\nRe-add \`agent:review\` or comment \`/agent retry\` to retry.`).catch(() => undefined)
      throw new Error(message)
    }

    try {
      const pr = await ghJson<{ headRefName: string; headRefOid: string; baseRefName: string; isCrossRepository: boolean }>([
        "pr", "view", prNumber, "--json", "headRefName,headRefOid,baseRefName,isCrossRepository",
      ])
      if (pr.isCrossRepository) {
        await removePrLabel(prNumber, "agent:review")
        await markFailed("Refused to run review on a cross-repository pull request.")
      }

      await removePrLabel(prNumber, "agent:review")
      await removePrLabel(prNumber, "agent:blocked")
      await addPrLabel(prNumber, "agent:in-progress")

      await using sandbox = await createPodmanSandbox({
        branch: pr.headRefName,
        preflightCommand: process.env.FORGEFLOW_SANDBOX_PREFLIGHT ?? undefined,
      })
      await git(["fetch", "origin", pr.baseRefName], { cwd: sandbox.worktreePath })
      await git(["reset", "--hard", pr.headRefOid], { cwd: sandbox.worktreePath })
      const context = await fetchPullRequestContext(prNumber, { cwd: sandbox.worktreePath })
      const result = await runSandboxWithExtraction({
        sandbox,
        name: `review-pr-${prNumber}`,
        promptFile,
        extractionPrompt,
        validate: validateReviewOutput,
        promptArgs: {
          PR_NUMBER: prNumber,
          BRANCH: pr.headRefName,
          PR_TITLE: context.prTitle,
          ISSUE_NUMBER: context.issueNumber || "(none)",
          ISSUE_TITLE: context.issueTitle || "(no linked issue)",
          LINKED_ISSUE: context.linkedIssue,
          DIFF_TO_MAIN: context.diff,
          PR_COMMENTS_JSON: context.prCommentsJson,
        },
      })

      const validInlineComments = filterInlineComments(result.output.inlineComments, context.diffLines)
      const validReplies = filterReplies(result.output.replies, context.validReplyIds)
      const headSha = await git(["rev-parse", "HEAD"])

      await pushBranch({ branch: pr.headRefName, forceWithLease: `refs/heads/${pr.headRefName}:${pr.headRefOid}` })

      const tmp = mkdtempSync(join(tmpdir(), "forgeflow-review-"))
      const payloadPath = join(tmp, "review_payload.json")
      writeFileSync(payloadPath, JSON.stringify({
        commit_id: headSha,
        event: "COMMENT",
        body: result.output.summary,
        comments: validInlineComments.map(comment => ({ path: comment.path, line: comment.line, side: "RIGHT", body: comment.body })),
      }, null, 2))
      await gh(["api", "--method", "POST", `repos/{owner}/{repo}/pulls/${prNumber}/reviews`, "--input", payloadPath])

      for (const reply of validReplies) {
        const resolved = await ghJson<{ data?: { node?: { databaseId?: number } } }>([
          "api", "graphql", "-f", "query=query($id:ID!){ node(id:$id){ ... on PullRequestReviewComment { databaseId } } }", "-F", `id=${reply.commentId}`,
        ])
        const restId = resolved.data?.node?.databaseId
        if (restId) await gh(["api", "--method", "POST", `repos/{owner}/{repo}/pulls/${prNumber}/comments/${restId}/replies`, "-f", `body=${reply.body}`])
      }
      await gh(["pr", "ready", prNumber]).catch(() => undefined)
      await commentPr(prNumber, "`agent:review` completed.")
      return { summary: result.output.summary, outputs: { commits: result.commits.length, inlineComments: validInlineComments.length, replies: validReplies.length, outputDir } }
    } catch (error) {
      await markFailed(error instanceof Error ? error.message : String(error))
    } finally {
      await removePrLabel(prNumber, "agent:in-progress")
    }
  },
})
