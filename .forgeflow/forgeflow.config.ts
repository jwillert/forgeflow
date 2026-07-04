import { defineConfig } from "forgeflow"
import { github } from "forgeflow/github"
import { sqliteState } from "forgeflow/sqlite"
import { implement } from "./workflows/implement.js"
import { review } from "./workflows/review.js"
import { updateBranch } from "./workflows/update-branch.js"

export default defineConfig(({ env }) => {
  const gh = github({ token: env.required("GH_TOKEN") })

  return {
    state: sqliteState(env.optional("FORGEFLOW_DB", ".forgeflow/forgeflow.db")),
    defaultDeferInterval: env.optional("FORGEFLOW_DEFAULT_DEFER_INTERVAL", "15m"),
    enabledTargets: [
      gh.repo(env.required("FORGEFLOW_GITHUB_REPO"), {
        baseBranch: env.optional("FORGEFLOW_BASE_REF", "main"),
        workflows: [implement, review, updateBranch],
      }),
    ],
  }
})
