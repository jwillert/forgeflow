import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineWorkflow, labelAdded, Match, type WorkTargetRef } from "forgeflow"
import { checkoutBaseBranch, commitsAhead, pushBranch } from "../shared/git.js"
import { optionalEnv } from "../shared/shell.js"
import { createPodmanSandbox, piAgent } from "../shared/sandcastle.js"

const here = dirname(fileURLToPath(import.meta.url))
const promptFile = join(here, "../prompts/implement.md")

export const implement = defineWorkflow("implement", {
  match: ({ event }) => {
    if (!labelAdded(event, "agent:implement")) return Match.ignore()
    if (event.workTarget.kind !== "issue") return Match.ignore()
    return Match.accept()
  },

  run: async ({ command, workTracker, codeHost, commandState }) => {
    const issueNumber = command.workTarget.id
    const outputDir = optionalEnv("FORGEFLOW_OUTPUT_DIR", "/tmp/forgeflow-output")

    const safeRemoveLabel = async (label: string) => {
      await workTracker.removeLabel(command.workTarget, label).catch(() => undefined)
    }
    const markFailed = async (message: string) => {
      await workTracker.addLabel(command.workTarget, "agent:blocked").catch(() => undefined)
      await workTracker.addComment(command.workTarget, `\`agent:implement\` run failed.\n\n**Reason:** ${message}\n\nRe-add \`agent:implement\` or comment \`/agent retry\` to retry.`).catch(() => undefined)
      throw new Error(message)
    }

    await safeRemoveLabel("agent:implement")
    await safeRemoveLabel("agent:blocked")
    await workTracker.addLabel(command.workTarget, "agent:in-progress")

    try {
      const checkout = await codeHost.resolveCheckout(command.codeTarget, command)

      await checkoutBaseBranch({ baseRef: checkout.baseRef })

      await using sandbox = await createPodmanSandbox({
        branch: checkout.workBranch,
        preflightCommand: process.env.FORGEFLOW_SANDBOX_PREFLIGHT ?? undefined,
      })
      const result = await sandbox.run({
        name: `implement-#${issueNumber}`,
        agent: piAgent(),
        promptFile,
        promptArgs: {
          ISSUE_NUMBER: issueNumber,
          ISSUE_TITLE: command.title,
          ISSUE_CONTEXT: command.body ?? `Issue #${issueNumber}: ${command.title}`,
          BRANCH: checkout.workBranch,
          BASE_REF: checkout.baseRef,
        },
        idleTimeoutSeconds: 900,
      })

      const count = await commitsAhead({ baseRef: checkout.baseRef, cwd: sandbox.worktreePath })
      if ((!Number.isFinite(count) || count === 0) && result.commits.length === 0) {
        await markFailed("Agent finished but no commits were made on the branch.")
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
        kind: "pull_request",
        id: changeRequest.id,
        url: changeRequest.url,
      }

      await workTracker.addLabel(reviewTarget, "agent:review").catch(() => undefined)
      await workTracker.addComment(command.workTarget, `Implementation completed.\n\nChange request: ${changeRequest.url ?? changeRequest.id}`)

      return { summary: `Implementation completed: ${changeRequest.url ?? changeRequest.id}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await markFailed(message)
    } finally {
      await safeRemoveLabel("agent:in-progress")
    }
  },
})
