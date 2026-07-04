import * as sandcastle from "@ai-hero/sandcastle"
import type { OutputObjectDefinition, RunOptions, RunResult } from "@ai-hero/sandcastle"
import { podman } from "@ai-hero/sandcastle/sandboxes/podman"

const sandboxProvider = podman({
  imageName: process.env.FORGEFLOW_SANDBOX_IMAGE ?? "forgeflow-agent",
  mounts: [
    {
      hostPath: "~/.pi/agent",
      sandboxPath: "/home/agent/.pi/agent",
    },
  ],  
})

export function piAgent() {
  return sandcastle.pi(process.env.PI_MODEL ?? "openai-codex/gpt-5.5", {
    thinking: (process.env.PI_THINKING as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined) ?? "low",
  })
}

export async function createPodmanSandbox(input: {
  branch: string
  preflightCommand?: string
  preflightTimeoutMs?: number
}) {
  await using sandbox = await sandcastle.createSandbox({
    sandbox: sandboxProvider,
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

  return sandbox
}

export async function runPodmanSandcastle(input: {
  name: string
  branch: string
  promptFile: string
  promptArgs: Record<string, string>
  idleTimeoutSeconds?: number
  preflightCommand?: string
  preflightTimeoutMs?: number
}) {
  await using sandbox = await createPodmanSandbox(input)
  return await sandbox.run({
    name: input.name,
    agent: piAgent(),
    promptFile: input.promptFile,
    promptArgs: input.promptArgs,
    idleTimeoutSeconds: input.idleTimeoutSeconds ?? 900,
  })
}

export interface RunWithExtractionOptions<T> extends Omit<RunOptions, "output"> {
  readonly output: OutputObjectDefinition<T>
  readonly extractionPrompt: string
  readonly maxRetries?: number
}

export async function runWithExtraction<T>(options: RunWithExtractionOptions<T>): Promise<RunResult & { output: T }> {
  const { output, extractionPrompt, maxRetries = 2, ...produceOptions } = options
  const produce = await sandcastle.run(produceOptions)
  const sessionId = produce.iterations.at(-1)?.sessionId
  if (!sessionId) throw new Error("Cannot extract structured output because the produce run had no session id.")
  const { promptArgs: _promptArgs, ...extractionOptions } = produceOptions
  const extraction = await sandcastle.run({
    ...extractionOptions,
    name: produceOptions.name ? `${produceOptions.name} (extract)` : undefined,
    promptFile: undefined,
    prompt: extractionPrompt,
    resumeSession: sessionId,
    output: { ...output, maxRetries },
  })
  return { ...produce, output: extraction.output }
}

export async function runSandboxWithExtraction<T>(input: {
  sandbox: Awaited<ReturnType<typeof createPodmanSandbox>>
  name: string
  promptFile: string
  promptArgs: Record<string, string>
  extractionPrompt: string
  validate: (value: unknown) => T
  idleTimeoutSeconds?: number
}): Promise<Awaited<ReturnType<Awaited<ReturnType<typeof createPodmanSandbox>>["run"]>> & { output: T }> {
  const produce = await input.sandbox.run({
    name: input.name,
    agent: piAgent(),
    promptFile: input.promptFile,
    promptArgs: input.promptArgs,
    idleTimeoutSeconds: input.idleTimeoutSeconds ?? 900,
  })
  if (!produce.resume) throw new Error("Cannot extract structured output because sandbox run cannot resume the agent session.")
  const extraction = await produce.resume(input.extractionPrompt, {
    name: `${input.name} (extract)`,
    idleTimeoutSeconds: 300,
  })
  const match = extraction.stdout.match(/<output>\s*([\s\S]*?)\s*<\/output>/)
  if (!match) throw new Error(`Extraction did not produce an <output> block.\n\n${extraction.stdout}`)
  return { ...produce, output: input.validate(JSON.parse(match[1])) }
}

export { sandcastle }
