import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineWorkflow, Match, labelAdded } from "../core/workflow.js"
import type { Workflow } from "../core/workflow.js"
import type { WorkTargetRef } from "../core/types.js"
import { checkoutBaseBranch, commitsAhead, pushBranch } from "./shared/git.js"
import { createPodmanSandbox, piAgent, type SandboxDefaults } from "./shared/sandcastle.js"
import { runWithAgentLifecycle } from "./shared/lifecycle.js"

const here = dirname(fileURLToPath(import.meta.url))
const defaultPromptFile = join(here, "prompts/implement.md")

export interface ImplementWorkflowOptions extends SandboxDefaults {
  readonly id?: string
  readonly triggerLabel?: string
  readonly reviewLabel?: string
  readonly blockedLabel?: string
  readonly inProgressLabel?: string
  readonly promptFile?: string
  readonly preflightCommand?: string
  readonly idleTimeoutSeconds?: number
}

export function createImplementWorkflow(options: ImplementWorkflowOptions = {}): Workflow {
  const triggerLabel = options.triggerLabel ?? "agent:implement"
  const reviewLabel = options.reviewLabel ?? "agent:review"
  const promptFile = options.promptFile ?? defaultPromptFile

  return defineWorkflow(options.id ?? "implement", {
    match: async ({ event, workReader }) => {
      if (!labelAdded(event, triggerLabel)) return Match.ignore()
      if (event.workTarget.kind !== "issue") return Match.ignore()

      const blockers = await workReader.listBlockingIssues(event.workTarget).catch(() => [])
      const openBlockerIds: string[] = []
      for (const blocker of blockers) {
        const snapshot = await workReader.getTarget(blocker).catch(() => undefined)
        if (snapshot?.state !== "closed") openBlockerIds.push(blocker.id)
      }
      if (openBlockerIds.length > 0) return Match.defer(`Blocked by #${openBlockerIds.join(", #")}`)

      return Match.accept()
    },

    run: async ({ command, workReader, workTracker, codeHost, codeReviewHost, commandState }) => runWithAgentLifecycle(
      { workTracker, target: command.workTarget, labels: { trigger: triggerLabel, blocked: options.blockedLabel, inProgress: options.inProgressLabel } },
      async () => {
        const issueNumber = command.workTarget.id
        const checkout = await codeHost.resolveCheckout(command.codeTarget, command)

        await checkoutBaseBranch({ baseRef: checkout.baseRef })

        const issueSnapshot = await workReader.getTarget(command.workTarget).catch(() => undefined)
        const issueComments = await codeReviewHost.listGeneralComments(command.workTarget).catch(() => [])
        const issueContext = issueSnapshot
          ? [`# ${issueSnapshot.title}\n\n${issueSnapshot.body ?? ""}`, ...issueComments.map(c => `---\n${c.author ?? "unknown"}: ${c.body}`)].join("\n\n")
          : command.body ?? `Issue #${issueNumber}: ${command.title}`

        await using sandbox = await createPodmanSandbox({
          ...options,
          branch: checkout.workBranch,
          preflightCommand: options.preflightCommand,
        })
        const result = await sandbox.run({
          name: `implement-#${issueNumber}`,
          agent: piAgent(options),
          promptFile,
          promptArgs: {
            ISSUE_NUMBER: issueNumber,
            ISSUE_TITLE: command.title,
            ISSUE_CONTEXT: issueContext,
            BRANCH: checkout.workBranch,
            BASE_REF: checkout.baseRef,
          },
          idleTimeoutSeconds: options.idleTimeoutSeconds ?? 900,
        })

        const count = await commitsAhead({ baseRef: checkout.baseRef, cwd: sandbox.worktreePath })
        if ((!Number.isFinite(count) || count === 0) && result.commits.length === 0) {
          throw new Error("Agent finished but no commits were made on the branch.")
        }

        await pushBranch({ branch: checkout.workBranch, cwd: sandbox.worktreePath })

        const existing = await commandState.getLinkedChangeRequest()
        const changeRequest = await codeHost.openOrUpdateChangeRequest({
          existing,
          sourceBranch: {
            provider: command.codeTarget.provider,
            repo: command.codeTarget.repo,
            name: checkout.workBranch,
          },
          targetBranch: checkout.baseRef,
          title: `Fix #${issueNumber}: ${command.title}`.slice(0, 256),
          body: `Closes #${issueNumber}\n\nImplemented by the Forgeflow external workflow.`,
        })
        await commandState.linkChangeRequest(changeRequest)

        const reviewTarget: WorkTargetRef = {
          provider: command.workTarget.provider,
          repo: command.workTarget.repo,
          project: command.workTarget.project,
          kind: changeRequest.kind,
          id: changeRequest.id,
          url: changeRequest.url,
        }

        await workTracker.addLabel(reviewTarget, reviewLabel).catch(() => undefined)
        await workTracker.addComment(command.workTarget, `Implementation completed.\n\nChange request: ${changeRequest.url ?? changeRequest.id}`)

        return { summary: `Implementation completed: ${changeRequest.url ?? changeRequest.id}` }
      },
    ),
  })
}

export const implement = createImplementWorkflow()
