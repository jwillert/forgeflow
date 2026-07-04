import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"
import { defineWorkflow, labelAdded, Match } from "forgeflow"
import { pushBranch } from "../shared/git.js"
import { addPrLabel, commentPr, ghJson, removePrLabel } from "../shared/github.js"
import { createPodmanSandbox, piAgent, runSandboxWithExtraction } from "../shared/sandcastle.js"
import { validateUpdateBranchOutput } from "../shared/review.js"

const here = dirname(fileURLToPath(import.meta.url))
const promptFile = join(here, "../prompts/update-branch/prompt.md")
const extractionPrompt = readFileSync(join(here, "../prompts/update-branch/extraction.md"), "utf8")

export const updateBranch = defineWorkflow("update-branch", {
  match: ({ event }) => {
    if (!labelAdded(event, "agent:update-branch")) return Match.ignore()
    if (event.workTarget.kind !== "pull_request") return Match.ignore()
    return Match.accept()
  },

  run: async ({ command, workTracker }) => {
    const prNumber = command.workTarget.id

    const markFailed = async (message: string) => {
      await workTracker.addLabel(command.workTarget, "agent:blocked").catch(() => undefined)
      await workTracker.addComment(command.workTarget, `\`agent:update-branch\` run failed.\n\n**Reason:** ${message}\n\nRe-add \`agent:update-branch\` or comment \`/agent retry\` to retry.`).catch(() => undefined)
      throw new Error(message)
    }

    try {
      const pr = await ghJson<{ headRefName: string; headRefOid: string; baseRefName: string; isCrossRepository: boolean }>([
        "pr", "view", prNumber, "--json", "headRefName,headRefOid,baseRefName,isCrossRepository",
      ])
      if (pr.isCrossRepository) {
        await removePrLabel(prNumber, "agent:update-branch")
        await markFailed("Refused to update a cross-repository pull request.")
      }

      await removePrLabel(prNumber, "agent:update-branch")
      await removePrLabel(prNumber, "agent:blocked")
      await addPrLabel(prNumber, "agent:in-progress")

      await using sandbox = await createPodmanSandbox({ branch: pr.headRefName })
      await sandbox.exec(`git fetch origin ${pr.baseRefName}`)
      const mergeBase = (await sandbox.exec(`git merge-base HEAD origin/${pr.baseRefName}`)).stdout.trim()
      const baseSha = (await sandbox.exec(`git rev-parse origin/${pr.baseRefName}`)).stdout.trim()

      let comment = ""
      let shouldPush = false
      if (mergeBase === baseSha) {
        comment = `\`agent:update-branch\`: branch is already up to date with \`origin/${pr.baseRefName}\`. No merge needed.`
      } else {
        const merge = await sandbox.exec(`git merge origin/${pr.baseRefName} --no-edit`)
        if (merge.exitCode === 0) {
          comment = `\`agent:update-branch\`: merged \`origin/${pr.baseRefName}\` (\`${baseSha.slice(0, 7)}\`) into \`${pr.headRefName}\` cleanly — no conflicts.`
          shouldPush = true
        } else {
          const conflicts = (await sandbox.exec("git diff --name-only --diff-filter=U")).stdout.trim()
          if (!conflicts) await markFailed("git merge failed but no conflicts were reported.")

          const result = await runSandboxWithExtraction({
            sandbox,
            name: `update-branch-pr-${prNumber}`,
            promptFile,
            extractionPrompt,
            validate: validateUpdateBranchOutput,
            promptArgs: {
              PR_NUMBER: prNumber,
              BRANCH: pr.headRefName,
              BASE_REF: pr.baseRefName,
            },
          })
          const unresolved = (await sandbox.exec("git diff --name-only --diff-filter=U")).stdout.trim()
          if (unresolved) await markFailed(`Agent left unresolved conflicts in:\n${unresolved}`)
          if (result.commits.length === 0) {
            await sandbox.run({
              name: `commit-update-branch-${prNumber}`,
              agent: piAgent(),
              prompt: `Stage all changes and create one conventional commit for merging origin/${pr.baseRefName} into ${pr.headRefName}. Do not make further code changes.`,
            })
          }
          comment = result.output.comment
          shouldPush = true
        }
      }

      if (shouldPush) await pushBranch({ branch: pr.headRefName, forceWithLease: `refs/heads/${pr.headRefName}:${pr.headRefOid}` })
      if (comment) await commentPr(prNumber, comment)
      return { summary: comment || "Update branch completed." }
    } catch (error) {
      await markFailed(error instanceof Error ? error.message : String(error))
    } finally {
      await removePrLabel(prNumber, "agent:in-progress")
    }
  },
})
