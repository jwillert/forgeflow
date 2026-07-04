import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineWorkflow, Match, isChangeRequestKind, labelAdded } from "../core/workflow.js"
import type { Workflow } from "../core/workflow.js"
import { git, pushBranch } from "./shared/git.js"
import { createPodmanSandbox, runSandboxWithExtraction, type SandboxDefaults } from "./shared/sandcastle.js"
import { fetchChangeRequestContext, filterInlineComments, filterReplies, validateReviewOutput } from "./shared/review-output.js"
import { runWithAgentLifecycle } from "./shared/lifecycle.js"

const here = dirname(fileURLToPath(import.meta.url))
const defaultPromptFile = join(here, "prompts/review/prompt.md")
const defaultExtractionPrompt = await import("node:fs").then(fs => fs.readFileSync(join(here, "prompts/review/extraction.md"), "utf8"))

export interface ReviewWorkflowOptions extends SandboxDefaults {
  readonly id?: string
  readonly triggerLabel?: string
  readonly blockedLabel?: string
  readonly inProgressLabel?: string
  readonly promptFile?: string
  readonly extractionPrompt?: string
  readonly preflightCommand?: string
  readonly outputDir?: string
}

export function createReviewWorkflow(options: ReviewWorkflowOptions = {}): Workflow {
  const triggerLabel = options.triggerLabel ?? "agent:review"
  const promptFile = options.promptFile ?? defaultPromptFile
  const extractionPrompt = options.extractionPrompt ?? defaultExtractionPrompt

  return defineWorkflow(options.id ?? "review", {
    match: ({ event }) => {
      if (!labelAdded(event, triggerLabel)) return Match.ignore()
      if (!isChangeRequestKind(event.workTarget.kind)) return Match.ignore()
      return Match.accept()
    },

    run: async ({ command, workReader, workTracker, codeReviewHost }) => runWithAgentLifecycle(
      { workTracker, target: command.workTarget, labels: { trigger: triggerLabel, blocked: options.blockedLabel, inProgress: options.inProgressLabel } },
      async () => {
        const target = command.workTarget
        const outputDir = options.outputDir ?? process.env.FORGEFLOW_OUTPUT_DIR ?? "/tmp/forgeflow-output"

        const details = await codeReviewHost.getChangeRequestDetails(target)
        if (details.isCrossRepository) throw new Error("Refused to run review on a cross-repository change request.")

        await using sandbox = await createPodmanSandbox({
          ...options,
          branch: details.sourceBranch,
          preflightCommand: options.preflightCommand,
        })
        await git(["fetch", "origin", details.targetBranch], { cwd: sandbox.worktreePath })
        await git(["reset", "--hard", details.sourceSha], { cwd: sandbox.worktreePath })
        const context = await fetchChangeRequestContext({ target, workReader, codeReviewHost, cwd: sandbox.worktreePath })
        const result = await runSandboxWithExtraction({
          ...options,
          sandbox,
          name: `review-${target.kind}-${target.id}`,
          promptFile,
          extractionPrompt,
          validate: validateReviewOutput,
          promptArgs: {
            PR_NUMBER: target.id,
            BRANCH: details.sourceBranch,
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
        const headSha = await git(["rev-parse", "HEAD"], { cwd: sandbox.worktreePath })

        await pushBranch({ branch: details.sourceBranch, cwd: sandbox.worktreePath, forceWithLease: `refs/heads/${details.sourceBranch}:${details.sourceSha}` })

        await codeReviewHost.postReview(target, { commitSha: headSha, summary: result.output.summary, inlineComments: validInlineComments })
        for (const reply of validReplies) {
          await codeReviewHost.replyToThread(target, { threadId: reply.threadId, body: reply.body })
        }
        await codeReviewHost.markReady(target).catch(() => undefined)
        await workTracker.addComment(target, `\`${triggerLabel}\` completed.`)
        return { summary: result.output.summary, outputs: { commits: result.commits.length, inlineComments: validInlineComments.length, replies: validReplies.length, outputDir } }
      },
    ),
  })
}

export const review = createReviewWorkflow()
