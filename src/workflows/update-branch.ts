import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"
import { defineWorkflow, Match, isChangeRequestKind, labelAdded } from "../core/workflow.js"
import type { Workflow } from "../core/workflow.js"
import { pushBranch } from "./shared/git.js"
import { createAgentSandbox, piAgent, runSandboxWithExtraction, type SandboxDefaults } from "./shared/sandcastle.js"
import { validateUpdateBranchOutput } from "./shared/review-output.js"
import { runWithAgentLifecycle } from "./shared/lifecycle.js"

const here = dirname(fileURLToPath(import.meta.url))
const defaultPromptFile = join(here, "prompts/update-branch/prompt.md")
const defaultExtractionPrompt = readFileSync(join(here, "prompts/update-branch/extraction.md"), "utf8")

export interface UpdateBranchWorkflowOptions extends SandboxDefaults {
  readonly id?: string
  readonly triggerLabel?: string
  readonly blockedLabel?: string
  readonly inProgressLabel?: string
  readonly promptFile?: string
  readonly extractionPrompt?: string
}

export function createUpdateBranchWorkflow(options: UpdateBranchWorkflowOptions = {}): Workflow {
  const triggerLabel = options.triggerLabel ?? "agent:update-branch"
  const promptFile = options.promptFile ?? defaultPromptFile
  const extractionPrompt = options.extractionPrompt ?? defaultExtractionPrompt

  return defineWorkflow(options.id ?? "update-branch", {
    match: ({ event }) => {
      if (!labelAdded(event, triggerLabel)) return Match.ignore()
      if (!isChangeRequestKind(event.workTarget.kind)) return Match.ignore()
      return Match.accept()
    },

    run: async ({ command, workTracker, codeReviewHost }) => runWithAgentLifecycle(
      { workTracker, target: command.workTarget, labels: { trigger: triggerLabel, blocked: options.blockedLabel, inProgress: options.inProgressLabel } },
      async () => {
        const target = command.workTarget

        const details = await codeReviewHost.getChangeRequestDetails(target)
        if (details.isCrossRepository) throw new Error("Refused to update a cross-repository change request.")

        await using sandbox = await createAgentSandbox({ ...options, branch: details.sourceBranch })
        await sandbox.exec(`git fetch origin ${details.targetBranch}`)
        const mergeBase = (await sandbox.exec(`git merge-base HEAD origin/${details.targetBranch}`)).stdout.trim()
        const baseSha = (await sandbox.exec(`git rev-parse origin/${details.targetBranch}`)).stdout.trim()

        let comment = ""
        let shouldPush = false
        if (mergeBase === baseSha) {
          comment = `\`${triggerLabel}\`: branch is already up to date with \`origin/${details.targetBranch}\`. No merge needed.`
        } else {
          const merge = await sandbox.exec(`git merge origin/${details.targetBranch} --no-edit`)
          if (merge.exitCode === 0) {
            comment = `\`${triggerLabel}\`: merged \`origin/${details.targetBranch}\` (\`${baseSha.slice(0, 7)}\`) into \`${details.sourceBranch}\` cleanly — no conflicts.`
            shouldPush = true
          } else {
            const conflicts = (await sandbox.exec("git diff --name-only --diff-filter=U")).stdout.trim()
            if (!conflicts) throw new Error("git merge failed but no conflicts were reported.")

            const result = await runSandboxWithExtraction({
              ...options,
              sandbox,
              name: `update-branch-${target.kind}-${target.id}`,
              promptFile,
              extractionPrompt,
              validate: validateUpdateBranchOutput,
              promptArgs: {
                PR_NUMBER: target.id,
                BRANCH: details.sourceBranch,
                BASE_REF: details.targetBranch,
              },
            })
            const unresolved = (await sandbox.exec("git diff --name-only --diff-filter=U")).stdout.trim()
            if (unresolved) throw new Error(`Agent left unresolved conflicts in:\n${unresolved}`)
            if (result.commits.length === 0) {
              await sandbox.run({
                name: `commit-update-branch-${target.id}`,
                agent: piAgent(options),
                prompt: `Stage all changes and create one conventional commit for merging origin/${details.targetBranch} into ${details.sourceBranch}. Do not make further code changes.`,
              })
            }
            comment = result.output.comment
            shouldPush = true
          }
        }

        if (shouldPush) await pushBranch({ branch: details.sourceBranch, forceWithLease: `refs/heads/${details.sourceBranch}:${details.sourceSha}` })
        if (comment) await workTracker.addComment(target, comment)
        return { summary: comment || "Update branch completed." }
      },
    ),
  })
}

export const updateBranch = createUpdateBranchWorkflow()
