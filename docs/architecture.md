# Forgeflow Architecture

Forgeflow externalizes repository workflows that would otherwise live inside GitHub Actions or GitLab CI. The MVP focuses on GitHub and GitLab polling, turning labels/comments into durable Agent Commands that are run by a worker on user-controlled infrastructure.

A workflow can run anything: a Sandcastle script, a shell command, a local build, a Hermes call, or provider CLIs. Forgeflow does not provide an executor abstraction; workflow `run()` is ordinary TypeScript.

## Core flow

```text
forgeflow poll
  -> poll enabled targets
  -> normalize provider events
  -> apply baseline trust policy
  -> call workflow matchers with read-only capabilities
  -> create queued/deferred Agent Commands
  -> exit

forgeflow worker --parallel 3
  -> claim queued Agent Commands
  -> call workflow run() with mutating capabilities concurrently
  -> workflow scripts external commands and provider projections explicitly
  -> worker records internal workflow-run/command state
```

## Main seams

Forgeflow uses role-based capability interfaces instead of exposing concrete provider adapters to workflows.

### Event discovery

- `PollingEventSource`: discovers normalized events from enabled targets.
- Future `WebhookEventSource`: normalizes provider webhook payloads.

MVP is polling-only.

### Work capabilities

```ts
interface WorkReader {
  getTarget(target: WorkTargetRef): Promise<WorkTargetSnapshot>
}

interface WorkTracker extends WorkReader {
  addLabel(target: WorkTargetRef, label: string): Promise<void>
  removeLabel(target: WorkTargetRef, label: string): Promise<void>
  addComment(target: WorkTargetRef, body: string): Promise<CommentRef>
}
```

`match()` receives read-only capabilities. `run()` receives mutating capabilities.

### Code capabilities

```ts
interface CodeReader {
  resolveCheckout(target: CodeTargetRef): Promise<CheckoutSpec>
}

interface CodeHost extends CodeReader {
  openOrUpdateChangeRequest(input: OpenOrUpdateChangeRequestInput): Promise<ChangeRequestRef>
}
```

`resolveCheckout()` is non-mutating and returns checkout instructions. Workflow code decides whether to use those instructions or delegate clone/checkout/push behavior to an external script.

### External process helper

Forgeflow ships a small process helper for workflow scripts:

```ts
await runProcessOrThrow({
  command: "npx",
  args: ["tsx", ".sandcastle/agent-workflows/implement/implement.ts"],
  cwd: process.env.WORKSPACE_DIR,
  env: {
    ISSUE_NUMBER: command.workTarget.id,
    ISSUE_TITLE: command.title,
  },
})
```

This is a helper, not a framework-level executor seam. Workflows may use any process/library directly.

### Optional provider capabilities

Provider-specific behavior is exposed through a capability registry, not casts:

```ts
const transitions = capabilities.optional("jira.transitions")
```

## Workflow shape

```ts
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
      env: {
        ISSUE_NUMBER: command.workTarget.id,
        ISSUE_TITLE: command.title,
        BRANCH: `agent/issue-${command.workTarget.id}`,
      },
    })

    await workTracker.removeLabel(command.workTarget, "agent:running")
    await workTracker.addLabel(command.workTarget, "agent:done")
    await workTracker.addComment(command.workTarget, "External implement workflow completed.")

    return { summary: "External implement workflow completed." }
  },
})
```

Provider projections are explicit in `run()`. The engine records internal command/workflow-run state automatically.

## Configuration shape

```ts
import { defineConfig } from "forgeflow"
import { github } from "forgeflow/github"
import { gitlab } from "forgeflow/gitlab"
import { sqliteState } from "forgeflow/sqlite"

export default defineConfig(({ env }) => {
  const gh = github({ token: env.required("GITHUB_TOKEN") })
  const gl = gitlab({
    token: env.required("GITLAB_TOKEN"),
    baseUrl: env.optional("GITLAB_BASE_URL", "https://gitlab.com"),
  })

  return {
    state: sqliteState(env.optional("FORGEFLOW_DB", "./forgeflow.db")),
    defaultDeferInterval: "15m",
    enabledTargets: [
      gh.repo("jwillert/foo", { workflows: [implement] }),
      gl.project("group/bar", { workflows: [review] }),
    ],
  }
})
```

Enabled targets drive polling. Workflows are enabled per target using workflow object references, not strings.

## Command lifecycle

```text
normalized event
  -> ignored | rejected | deferred | accepted

accepted
  -> queued
  -> running
  -> succeeded | failed

deferred
  -> re-evaluated by future poll runs

failed
  -> terminal until explicit retry
```

Explicit retry is triggered by `/agent retry` and requeues the same Command ID.

## State

MVP state store: SQLite.

Persist:

- provider cursors
- normalized events
- observed target snapshots
- Agent Commands
- workflow runs
- command-to-change-request links
- process/workflow summaries and artifacts if workflows record them

Do not persist:

- raw credentials/tokens
- temporary sandbox paths

Raw provider payload storage is configurable and disabled by default.

## CLI and scripted invocation

```bash
forgeflow poll --config forgeflow.config.ts --max-events 100
forgeflow worker --config forgeflow.config.ts --parallel 3
```

`poll` is one-shot and intended for external schedulers such as cron/systemd. `worker` runs queued commands concurrently with `--parallel` defaulting to `3`; `--limit` can cap how many commands are claimed in one invocation.

Projects can also invoke Forgeflow from a script:

```ts
import { createEnvReader, createGateway } from "forgeflow"
import configFactory from "./forgeflow.config"

const config = await configFactory({ env: createEnvReader() })
const gateway = createGateway(config)
await gateway.runOnce({ maxEvents: 100, parallel: 3 })
```

Long-running worker mode can be added later.

## MVP scope

Included:

- GitHub polling
- GitLab polling
- label-triggered workflows by convention `agent:{workflowId}`
- `/agent retry`
- SQLite state
- explicit workflow projections
- external process helper

Not included initially:

- webhooks
- Jira/Bitbucket providers
- built-in opinionated workflows
- automatic lifecycle label/comment projection
- long-running scheduler daemon
