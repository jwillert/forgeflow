export { createGateway, ForgeflowGateway } from "./core/engine.js"
export { drainUntilIdle } from "./core/drain.js"
export { defineConfig, createEnvReader } from "./core/config.js"
export { defineWorkflow, Match, labelAdded, defaultCommandId, defaultWorkBranch } from "./core/workflow.js"
export type { ForgeflowConfig, EnabledTarget, EnvReader } from "./core/config.js"
export type { DrainIteration, DrainUntilIdleOptions, DrainUntilIdleResult, RunOnceGateway, RunOnceOptions, RunOnceResult } from "./core/drain.js"
export type { Workflow, MatchDecision, MatchContext, RunContext, WorkflowRunResult } from "./core/workflow.js"
export type { StateStore } from "./core/state.js"
export type * from "./core/types.js"
export type * from "./core/capabilities.js"
export { runProcess, runProcessOrThrow } from "./process/index.js"
export type { RunProcessOptions, RunProcessResult } from "./process/index.js"

export class WorkflowFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowFailed"
  }
}
