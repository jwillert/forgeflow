import { spawn } from "node:child_process"

export type RunProcessOptions = {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
}

export type RunProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export async function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM")
          reject(new Error(`Process timed out after ${options.timeoutMs}ms: ${options.command}`))
        }, options.timeoutMs)
      : undefined

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk)
      stdout += text
      process.stdout.write(text)
    })
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk)
      stderr += text
      process.stderr.write(text)
    })
    child.on("error", (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer)
      resolve({ exitCode: exitCode ?? 1, stdout, stderr })
    })
  })
}

export async function runProcessOrThrow(options: RunProcessOptions): Promise<RunProcessResult> {
  const result = await runProcess(options)
  if (result.exitCode !== 0) {
    throw new Error(`Process failed with exit code ${result.exitCode}: ${options.command} ${(options.args ?? []).join(" ")}`)
  }
  return result
}
