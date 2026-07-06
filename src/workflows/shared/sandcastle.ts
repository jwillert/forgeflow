import * as sandcastle from "@ai-hero/sandcastle"
import type { SandboxProvider } from "@ai-hero/sandcastle"
import { podman } from "@ai-hero/sandcastle/sandboxes/podman"

export type AgentThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"

export interface SandboxDefaults {
  /** Podman image name, used only when `sandboxProvider` isn't given (default: forgeflow-agent). */
  readonly sandboxImage?: string
  /**
   * Bring your own sandcastle sandbox provider (e.g. `docker({ imageName: "forgeflow-agent" })`)
   * instead of the default podman one. Must support the persistent multi-run pattern
   * `createSandbox()` provides — podman and docker both do; sandcastle's isolated
   * providers (daytona, vercel) and no-sandbox do not fit this execution model.
   * When set, `sandboxImage` is ignored and you own wiring any mounts yourself —
   * see `piAgentAuthMount()` for the mount the default podman setup uses.
   */
  readonly sandboxProvider?: SandboxProvider
  readonly model?: string
  readonly thinking?: AgentThinking
}

/** The bind-mount the default podman sandbox uses to give the Pi agent its host auth. Reuse this if you bring your own sandbox provider and still want Pi's host auth available. */
export function piAgentAuthMount() {
  return { hostPath: "~/.pi/agent", sandboxPath: "/home/agent/.pi/agent" }
}

export function piAgent(defaults: SandboxDefaults = {}): ReturnType<typeof sandcastle.pi> {
  const model = defaults.model ?? process.env.PI_MODEL ?? "openai-codex/gpt-5.5"
  const thinking = defaults.thinking ?? (process.env.PI_THINKING as AgentThinking | undefined) ?? "low"
  return sandcastle.pi(model, { thinking })
}

function defaultPodmanProvider(defaults: SandboxDefaults = {}): SandboxProvider {
  return podman({
    imageName: defaults.sandboxImage ?? process.env.FORGEFLOW_SANDBOX_IMAGE ?? "forgeflow-agent",
    mounts: [piAgentAuthMount()],
  })
}

export async function createAgentSandbox(input: SandboxDefaults & {
  branch: string
  preflightCommand?: string
  preflightTimeoutMs?: number
}) {
  return await sandcastle.createSandbox({
    sandbox: input.sandboxProvider ?? defaultPodmanProvider(input),
    branch: input.branch,
    hooks: input.preflightCommand
      ? {
          sandbox: {
            onSandboxReady: [
              {
                command: input.preflightCommand,
                timeoutMs: input.preflightTimeoutMs ?? 600_000,
              },
            ],
          },
        }
      : undefined,
  })
}

function stripCodeFence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return fenced ? fenced[1] : text
}

function extractBalancedJson(text: string): string | undefined {
  const start = text.indexOf("{")
  if (start === -1) return undefined
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

function parseStructuredJson(raw: string): unknown {
  const unfenced = stripCodeFence(raw)
  try {
    return JSON.parse(unfenced)
  } catch (error) {
    const balanced = extractBalancedJson(unfenced)
    if (balanced === undefined) throw error
    return JSON.parse(balanced)
  }
}

export async function runSandboxWithExtraction<T>(input: SandboxDefaults & {
  sandbox: Awaited<ReturnType<typeof createAgentSandbox>>
  name: string
  promptFile: string
  promptArgs: Record<string, string>
  extractionPrompt: string
  validate: (value: unknown) => T
  idleTimeoutSeconds?: number
  maxRetries?: number
}): Promise<Awaited<ReturnType<Awaited<ReturnType<typeof createAgentSandbox>>["run"]>> & { output: T }> {
  const produce = await input.sandbox.run({
    name: input.name,
    agent: piAgent(input),
    promptFile: input.promptFile,
    promptArgs: input.promptArgs,
    idleTimeoutSeconds: input.idleTimeoutSeconds ?? 900,
  })
  const sessionId = produce.iterations.at(-1)?.sessionId
  if (!sessionId) throw new Error("Cannot extract structured output because the produce run had no session id.")

  const maxRetries = input.maxRetries ?? 2
  let resumeFrom = sessionId
  let prompt = input.extractionPrompt

  for (let attempt = 0; ; attempt++) {
    const extraction = await input.sandbox.run({
      name: attempt === 0 ? `${input.name} (extract)` : `${input.name} (extract retry ${attempt})`,
      agent: piAgent(input),
      prompt,
      resumeSession: resumeFrom,
      idleTimeoutSeconds: 300,
    })

    const match = extraction.stdout.match(/<output>\s*([\s\S]*?)\s*<\/output>/)
    const outcome = match
      ? (() => { try { return { ok: true as const, value: input.validate(parseStructuredJson(match[1])) } } catch (error) { return { ok: false as const, error } } })()
      : { ok: false as const, error: new Error("no <output> block found") }

    if (outcome.ok) return { ...produce, output: outcome.value }

    const extractionSessionId = extraction.iterations.at(-1)?.sessionId
    if (attempt >= maxRetries || !extractionSessionId) {
      const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
      throw new Error(`Extraction did not produce a valid <output> block after ${attempt + 1} attempt(s): ${reason}\n\n${extraction.stdout}`)
    }

    resumeFrom = extractionSessionId
    const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    prompt = `Your last response's <output> block could not be parsed: ${reason}\n\nRe-emit ONLY a corrected <output> block containing valid JSON matching the requested schema. Do not wrap it in a markdown code fence and do not include any other text.`
  }
}
