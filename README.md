# Forgeflow

Forgeflow externalizes repository workflows that would otherwise live inside GitHub Actions or GitLab CI. It polls enabled targets, turns matching labels/comments into durable Agent Commands, and lets a worker run user-defined TypeScript workflows on your own machine or internal infrastructure.

The workflow can call anything: Sandcastle scripts, shell commands, local tools, Hermes, build scripts, or provider CLIs.

## MVP commands

```bash
forgeflow poll --config forgeflow.config.ts --max-events 100
forgeflow worker --config forgeflow.config.ts --parallel 3
```

`poll` is one-shot and intended for cron/systemd. `worker` claims queued commands and runs workflows concurrently. `--parallel` defaults to `3`; `--limit` defaults to the same value.

## Scripted invocation

You can call Forgeflow from your own `run.ts` instead of using the CLI directly:

```ts
import { createEnvReader, createGateway } from "forgeflow"
import configFactory from "./.forgeflow/forgeflow.config"

const config = await configFactory({ env: createEnvReader() })
const gateway = createGateway(config)

const result = await gateway.runOnce({
  maxEvents: 100,
  parallel: 3,
})

console.log(result)
```

Then run the project-local Forgeflow workflow:

```bash
npx tsx .forgeflow/run.ts
```

## Config shape

See `examples/forgeflow.config.ts` and `examples/run.ts` for fuller examples.

```ts
import { defineConfig, defineWorkflow, labelAdded, Match, runProcessOrThrow } from "forgeflow"
import { github } from "forgeflow/github"
import { sqliteState } from "forgeflow/sqlite"

const implement = defineWorkflow("implement", {
  match: ({ event }) => labelAdded(event, "agent:implement") ? Match.accept() : Match.ignore(),
  run: async ({ command, workTracker }) => {
    await workTracker.addLabel(command.workTarget, "agent:running")
    await workTracker.removeLabel(command.workTarget, "agent:implement")

    await runProcessOrThrow({
      command: "npx",
      args: ["tsx", ".sandcastle/agent-workflows/implement/implement.ts"],
      cwd: process.env.WORKSPACE_DIR,
      env: {
        ISSUE_NUMBER: command.workTarget.id,
        ISSUE_TITLE: command.title,
        BRANCH: `agent/issue-${command.workTarget.id}`,
      },
    })

    await workTracker.removeLabel(command.workTarget, "agent:running")
    await workTracker.addLabel(command.workTarget, "agent:done")
  },
})

export default defineConfig(({ env }) => {
  const gh = github({ token: env.required("GITHUB_TOKEN") })

  return {
    state: sqliteState(env.optional("FORGEFLOW_DB", "./forgeflow.db")),
    enabledTargets: [
      gh.repo("owner/repo", { workflows: [implement] }),
    ],
  }
})
```

## Design docs

- `CONTEXT.md` — domain glossary
- `docs/architecture.md` — architecture overview
- `docs/adr/` — architectural decisions
