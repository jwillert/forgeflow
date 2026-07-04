import type { TrustPolicy } from "./capabilities.js"
import type { StateStore } from "./state.js"
import type { Workflow } from "./workflow.js"

export type EnabledTarget = {
  provider: string
  id: string
  codeRepo: string
  baseBranch?: string
  workflows: Workflow[]
  pollingSource: import("./capabilities.js").PollingEventSource
  workReader: import("./capabilities.js").WorkReader
  workTracker: import("./capabilities.js").WorkTracker
  codeReader: import("./capabilities.js").CodeReader
  codeHost: import("./capabilities.js").CodeHost
  codeReviewHost: import("./capabilities.js").CodeReviewHost
}

export type ForgeflowConfig = {
  state: StateStore
  enabledTargets: EnabledTarget[]
  trustPolicy?: TrustPolicy
  defaultDeferInterval?: string
  eventAudit?: { storeRawPayloads?: boolean | "redacted" }
  capabilities?: Record<string, unknown>
}

export type EnvReader = {
  required(name: string): string
  optional(name: string): string | undefined
  optional(name: string, defaultValue: string): string
}

export function createEnvReader(source: NodeJS.ProcessEnv = process.env): EnvReader {
  function optional(name: string): string | undefined
  function optional(name: string, defaultValue: string): string
  function optional(name: string, defaultValue?: string): string | undefined {
    return source[name] ?? defaultValue
  }

  return {
    required(name: string): string {
      const value = source[name]
      if (!value) throw new Error(`Missing required environment variable ${name}`)
      return value
    },
    optional,
  }
}

export function defineConfig(factory: (ctx: { env: EnvReader }) => ForgeflowConfig | Promise<ForgeflowConfig>) {
  return factory
}

export function defaultTrustPolicy(): TrustPolicy {
  return {
    async canProcessEvent() {
      return { allowed: true }
    },
  }
}
