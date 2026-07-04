import { defineConfig, defineWorkflow, labelAdded, Match, runProcessOrThrow } from "forgeflow"
import { github } from "forgeflow/github"
import { gitlab } from "forgeflow/gitlab"
import { sqliteState } from "forgeflow/sqlite"

const implement = defineWorkflow("implement", {
  match: async ({ event }) => {
    if (!labelAdded(event, "agent:implement")) return Match.ignore()
    return Match.accept()
  },

  run: async ({ command, workTracker }) => {
    await workTracker.addLabel(command.workTarget, "agent:running")
    await workTracker.removeLabel(command.workTarget, "agent:implement")

    await runProcessOrThrow({
      command: "npx",
      args: ["tsx", ".sandcastle/agent-workflows/implement/implement.ts"],
      cwd: process.env.WORKSPACE_DIR,
      timeoutMs: 90 * 60_000,
      env: {
        ISSUE_NUMBER: command.workTarget.id,
        ISSUE_TITLE: command.title,
        BRANCH: `agent/issue-${command.workTarget.id}`,
        OUTPUT_DIR: process.env.OUTPUT_DIR ?? "/tmp/forgeflow-output",
      },
    })

    await workTracker.removeLabel(command.workTarget, "agent:running")
    await workTracker.addLabel(command.workTarget, "agent:done")
    await workTracker.addComment(command.workTarget, "External implement workflow completed.")

    return { summary: "External implement workflow completed." }
  },
})

export default defineConfig(({ env }) => {
  const gh = github({ token: env.required("GITHUB_TOKEN") })
  const gl = gitlab({
    token: env.required("GITLAB_TOKEN"),
    baseUrl: env.optional("GITLAB_BASE_URL", "https://gitlab.com"),
  })

  return {
    state: sqliteState(env.optional("FORGEFLOW_DB", "./forgeflow.db")),
    enabledTargets: [
      gh.repo("jwillert/example", { workflows: [implement] }),
      gl.project("group/example", { workflows: [implement] }),
    ],
  }
})
