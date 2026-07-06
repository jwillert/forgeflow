import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, appendFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const here = dirname(fileURLToPath(import.meta.url))
const bundledPromptsDir = join(here, "../workflows/prompts")
const templatesDir = join(here, "templates")

export type InitOptions = {
  provider: "github" | "gitlab"
  repo: string
  dir: string
  baseBranch?: string
  force?: boolean
}

function detectBaseBranch(): string {
  try {
    return execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim() || "main"
  } catch {
    return "main"
  }
}

function writeFile(path: string, content: string, force: boolean | undefined, written: string[], skipped: string[]) {
  if (existsSync(path) && !force) {
    skipped.push(path)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  written.push(path)
}

function copyFile(from: string, to: string, force: boolean | undefined, written: string[], skipped: string[]) {
  if (existsSync(to) && !force) {
    skipped.push(to)
    return
  }
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
  written.push(to)
}

function configTemplate(options: Required<Pick<InitOptions, "provider" | "repo" | "baseBranch">>, dir: string): string {
  const providerImport = options.provider === "github"
    ? `import { github } from "@jwillert/forgeflow/github"`
    : `import { gitlab } from "@jwillert/forgeflow/gitlab"`

  const targetSetup = options.provider === "github"
    ? `  const gh = github({ token: env.required("GH_TOKEN") })
  const target = gh.repo(env.required("FORGEFLOW_GITHUB_REPO"), {
    baseBranch: env.optional("FORGEFLOW_BASE_REF", "${options.baseBranch}"),
    workflows: [implement, review, updateBranch],
  })`
    : `  const gl = gitlab({
    token: env.required("GITLAB_TOKEN"),
    baseUrl: env.optional("FORGEFLOW_GITLAB_BASE_URL", "https://gitlab.com"),
  })
  const target = gl.project(env.required("FORGEFLOW_GITLAB_PROJECT"), {
    baseBranch: env.optional("FORGEFLOW_BASE_REF", "${options.baseBranch}"),
    workflows: [implement, review, updateBranch],
  })`

  return `import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { docker } from "@ai-hero/sandcastle/sandboxes/docker"
import { podman } from "@ai-hero/sandcastle/sandboxes/podman"
import { defineConfig, type EnvReader } from "@jwillert/forgeflow"
${providerImport}
import { sqliteState } from "@jwillert/forgeflow/sqlite"
import { createImplementWorkflow, createReviewWorkflow, createUpdateBranchWorkflow, piAgentAuthMount } from "@jwillert/forgeflow/workflows"

const here = dirname(fileURLToPath(import.meta.url))

// Prompts below were copied from forgeflow/workflows by \`forgeflow init\` — edit
// freely, or delete the promptFile/extractionPrompt overrides to fall back to
// the package's bundled defaults.

// Podman by default; set FORGEFLOW_SANDBOX_RUNTIME=docker to use Docker instead.
function buildSandboxProvider(env: EnvReader) {
  const runtime = env.optional("FORGEFLOW_SANDBOX_RUNTIME", "podman")
  const imageName = env.optional("FORGEFLOW_SANDBOX_IMAGE", "forgeflow-agent")
  const mounts = [piAgentAuthMount()]
  if (runtime === "podman") return podman({ imageName, mounts })
  if (runtime === "docker") return docker({ imageName, mounts })
  throw new Error(\`Unknown FORGEFLOW_SANDBOX_RUNTIME "\${runtime}" — expected "docker" or "podman"\`)
}

export default defineConfig(({ env }) => {
  const sandboxProvider = buildSandboxProvider(env)

  const implement = createImplementWorkflow({
    sandboxProvider,
    promptFile: join(here, "prompts/implement.md"),
  })
  const review = createReviewWorkflow({
    sandboxProvider,
    promptFile: join(here, "prompts/review/prompt.md"),
    extractionPrompt: readFileSync(join(here, "prompts/review/extraction.md"), "utf8"),
  })
  const updateBranch = createUpdateBranchWorkflow({
    sandboxProvider,
    promptFile: join(here, "prompts/update-branch/prompt.md"),
    extractionPrompt: readFileSync(join(here, "prompts/update-branch/extraction.md"), "utf8"),
  })

${targetSetup}

  return {
    state: sqliteState(env.optional("FORGEFLOW_DB", "${dir}/forgeflow.db")),
    defaultDeferInterval: env.optional("FORGEFLOW_DEFAULT_DEFER_INTERVAL", "15m"),
    enabledTargets: [target],
  }
})
`
}

function envExampleTemplate(options: Required<Pick<InitOptions, "provider" | "repo" | "baseBranch">>, dir: string): string {
  const providerLines = options.provider === "github"
    ? `# GitHub access token. Needs repo contents/issues/pull-request permissions.
GH_TOKEN=

# Repository this config watches, e.g. "owner/repo".
FORGEFLOW_GITHUB_REPO=${options.repo}`
    : `# GitLab access token. Needs api scope on the target project.
GITLAB_TOKEN=

# Self-managed GitLab instance base URL, if not gitlab.com.
FORGEFLOW_GITLAB_BASE_URL=https://gitlab.com

# Project this config watches, e.g. "group/project".
FORGEFLOW_GITLAB_PROJECT=${options.repo}`

  return `${providerLines}

# Base branch used for implementation work branches.
FORGEFLOW_BASE_REF=${options.baseBranch}

# SQLite database path for Forgeflow state.
FORGEFLOW_DB=${dir}/forgeflow.db

# Max provider events/deferred commands handled per run.
FORGEFLOW_MAX_EVENTS=100

# Number of queued commands run concurrently.
FORGEFLOW_PARALLEL=3

# Optional cap for commands claimed in one worker run. Empty means defaults to FORGEFLOW_PARALLEL.
FORGEFLOW_LIMIT=

# Container runtime used by the Sandcastle sandbox provider: "podman" (default)
# or "docker".
FORGEFLOW_SANDBOX_RUNTIME=podman

# Image used by the sandbox provider. Build it with:
#   bash ${dir}/build-image.sh
FORGEFLOW_SANDBOX_IMAGE=forgeflow-agent
FORGEFLOW_SANDBOX_DOCKERFILE=${dir}/Dockerfile
FORGEFLOW_SANDBOX_BUILD_CONTEXT=.

# Optional command executed inside the sandbox after creation, before the agent runs.
# Example: npm ci
FORGEFLOW_SANDBOX_PREFLIGHT=

# Optional output directory used by workflows.
FORGEFLOW_OUTPUT_DIR=/tmp/forgeflow-output

# Pi agent model settings.
PI_MODEL=openai-codex/gpt-5.5
PI_THINKING=low
`
}

function ensureGitignore(root: string, dir: string, written: string[]) {
  const gitignorePath = join(root, ".gitignore")
  const relDir = relative(root, dir) || dir
  const lines = [
    `${relDir}/*.db`,
    `${relDir}/*.db-shm`,
    `${relDir}/*.db-wal`,
    `${relDir}/*.lock`,
    `${relDir}/.env`,
    `!${relDir}/.env.example`,
  ]
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : ""
  const missing = lines.filter(line => !existing.includes(line))
  if (missing.length === 0) return
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
  appendFileSync(gitignorePath, `${separator}${existing.length > 0 ? "\n" : ""}# Forgeflow\n${missing.join("\n")}\n`)
  written.push(gitignorePath)
}

function ownSandcastleVersionRange(): string {
  const ownPkgPath = join(here, "../../package.json")
  const ownPkg = JSON.parse(readFileSync(ownPkgPath, "utf8"))
  return ownPkg.dependencies?.["@ai-hero/sandcastle"] ?? "*"
}

function mergePackageJson(root: string, dir: string, written: string[], skipped: string[]) {
  const pkgPath = join(root, "package.json")
  if (!existsSync(pkgPath)) return
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  pkg.scripts ??= {}
  pkg.devDependencies ??= {}
  let changed = false

  // The generated config uses ESM imports (including sandcastle's docker/podman
  // subpaths, which are only exported for "import", not "require") — it needs
  // the project to be ESM. Only set this when unset; if the project has
  // explicitly opted into CommonJS, forcing it to "module" could break the
  // rest of the project, so leave it and surface a warning instead.
  if (pkg.type === undefined) {
    pkg.type = "module"
    changed = true
  } else if (pkg.type !== "module") {
    skipped.push(`package.json#type is "${pkg.type}", not "module" — forgeflow.config.ts uses ESM imports and will fail to load until this project is ESM`)
  }

  const desiredScripts: Record<string, string> = {
    "forgeflow:once": `forgeflow run --config ${dir}/forgeflow.config.ts`,
    "forgeflow:drain": `forgeflow drain --config ${dir}/forgeflow.config.ts`,
  }
  const desiredDevDependencies: Record<string, string> = {
    // The generated config imports docker()/podman() sandbox providers directly.
    "@ai-hero/sandcastle": ownSandcastleVersionRange(),
  }
  for (const [key, value] of Object.entries(desiredScripts)) {
    if (pkg.scripts[key]) { skipped.push(`package.json#scripts.${key}`); continue }
    pkg.scripts[key] = value
    changed = true
  }
  for (const [key, value] of Object.entries(desiredDevDependencies)) {
    if (pkg.dependencies?.[key] || pkg.devDependencies[key]) { skipped.push(`package.json#devDependencies.${key}`); continue }
    pkg.devDependencies[key] = value
    changed = true
  }
  if (changed) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
    written.push(pkgPath)
  }
}

export function runInit(options: InitOptions): { written: string[]; skipped: string[] } {
  const root = process.cwd()
  const dir = resolve(root, options.dir)
  const baseBranch = options.baseBranch ?? detectBaseBranch()
  const written: string[] = []
  const skipped: string[] = []

  writeFile(join(dir, "forgeflow.config.ts"), configTemplate({ provider: options.provider, repo: options.repo, baseBranch }, options.dir), options.force, written, skipped)
  writeFile(join(dir, ".env.example"), envExampleTemplate({ provider: options.provider, repo: options.repo, baseBranch }, options.dir), options.force, written, skipped)

  for (const promptFile of ["implement.md", "review/prompt.md", "review/extraction.md", "update-branch/prompt.md", "update-branch/extraction.md"]) {
    copyFile(join(bundledPromptsDir, promptFile), join(dir, "prompts", promptFile), options.force, written, skipped)
  }

  copyFile(join(templatesDir, "Dockerfile"), join(dir, "Dockerfile"), options.force, written, skipped)
  copyFile(join(templatesDir, "build-image.sh"), join(dir, "build-image.sh"), options.force, written, skipped)

  ensureGitignore(root, dir, written)
  mergePackageJson(root, options.dir, written, skipped)

  return { written, skipped }
}
