import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runProcessOrThrow } from "forgeflow"

export function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

export function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

export async function bash(script: string, env: Record<string, string | undefined> = {}, timeoutMs?: number): Promise<string> {
  const result = await runProcessOrThrow({
    command: "bash",
    args: ["-lc", script],
    cwd: process.cwd(),
    env,
    timeoutMs,
  })
  return result.stdout.trim()
}

export function writeTempFile(prefix: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const file = join(dir, "body.md")
  writeFileSync(file, content)
  return file
}

export function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined
}

export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}
