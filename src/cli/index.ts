#!/usr/bin/env node
import { Command } from "commander"
import { config as loadEnv } from "dotenv"
import { pathToFileURL } from "node:url"
import { dirname, extname, join, resolve } from "node:path"
import { tsImport } from "tsx/esm/api"
import { createGateway } from "../core/engine.js"
import { createEnvReader, type ForgeflowConfig } from "../core/config.js"
import { withLock, withLockBlocking } from "./lock.js"
import { runInit } from "./init.js"

type ConfigFactory = (ctx: { env: ReturnType<typeof createEnvReader> }) => ForgeflowConfig | Promise<ForgeflowConfig>

async function loadConfig(path: string): Promise<ForgeflowConfig> {
  const resolved = resolve(path)
  const mod = extname(resolved) === ".ts"
    ? await tsImport(resolved, import.meta.url)
    : await import(pathToFileURL(resolved).href)
  const exported = mod.default?.default ?? mod.default
  if (typeof exported === "function") return await (exported as ConfigFactory)({ env: createEnvReader() })
  return exported as ForgeflowConfig
}

function loadEnvFile(configPath: string, envPath?: string) {
  loadEnv({ path: envPath ?? join(dirname(resolve(configPath)), ".env") })
}

const program = new Command()
  .name("forgeflow")
  .description("Agent workflow gateway")
  .option("--config <path>", "config file", "forgeflow.config.ts")

program.command("poll")
  .option("--max-events <number>", "maximum events/rechecks to process", v => Number(v), 100)
  .action(async (opts) => {
    const configPath = program.opts().config
    const config = await loadConfig(configPath)
    const result = await createGateway(config).poll({ maxEvents: opts.maxEvents })
    console.log(JSON.stringify(result, null, 2))
  })

program.command("worker")
  .option("--limit <number>", "maximum commands to claim; defaults to --parallel", v => Number(v))
  .option("--parallel <number>", "maximum commands to run concurrently", v => Number(v), 3)
  .action(async (opts) => {
    const configPath = program.opts().config
    const config = await loadConfig(configPath)
    const result = await createGateway(config).worker({ limit: opts.limit, parallel: opts.parallel })
    console.log(JSON.stringify(result, null, 2))
  })

program.command("run")
  .description("Poll once and process everything currently queued")
  .option("--env <path>", "path to .env file (default: <config dir>/.env)")
  .option("--max-events <number>", "maximum events/rechecks to process", v => Number(v), 100)
  .option("--limit <number>", "maximum commands to claim; defaults to --parallel", v => Number(v))
  .option("--parallel <number>", "maximum commands to run concurrently", v => Number(v), 3)
  .option("--lock <path>", "lock file path (default: <config dir>/forgeflow.lock)")
  .action(async (opts) => {
    const configPath = program.opts().config
    loadEnvFile(configPath, opts.env)
    const lockPath = opts.lock ?? join(dirname(resolve(configPath)), "forgeflow.lock")
    const result = await withLock(lockPath, async () => {
      const config = await loadConfig(configPath)
      return createGateway(config).runOnce({ maxEvents: opts.maxEvents, parallel: opts.parallel, limit: opts.limit })
    })
    console.log(JSON.stringify(result, null, 2))
  })

program.command("drain")
  .description("Run repeatedly until there is nothing left to do")
  .option("--env <path>", "path to .env file (default: <config dir>/.env)")
  .option("--max-events <number>", "maximum events/rechecks to process per iteration", v => Number(v), 100)
  .option("--limit <number>", "maximum commands to claim per iteration; defaults to --parallel", v => Number(v))
  .option("--parallel <number>", "maximum commands to run concurrently", v => Number(v), 3)
  .option("--max-iterations <number>", "stop after this many iterations even if work remains", v => Number(v), 20)
  .option("--lock <path>", "lock file path (default: <config dir>/forgeflow.lock)")
  .action(async (opts) => {
    const configPath = program.opts().config
    loadEnvFile(configPath, opts.env)
    const lockPath = opts.lock ?? join(dirname(resolve(configPath)), "forgeflow.lock")
    await withLockBlocking(lockPath, async () => {
      const config = await loadConfig(configPath)
      const gateway = createGateway(config)
      for (let iteration = 1; iteration <= opts.maxIterations; iteration++) {
        console.log(`\n=== Forgeflow drain iteration ${iteration}/${opts.maxIterations} ===`)
        const result = await gateway.runOnce({ maxEvents: opts.maxEvents, parallel: opts.parallel, limit: opts.limit })
        console.log(JSON.stringify(result, null, 2))
        if (result.poll.events === 0 && result.poll.commands === 0 && result.worker.processed === 0) {
          console.log("Forgeflow idle.")
          return
        }
      }
      console.log(`Forgeflow drain stopped after ${opts.maxIterations} iteration(s).`)
    })
  })

program.command("init")
  .description("Scaffold a forgeflow config, prompts, and sandbox image for a new project")
  .requiredOption("--provider <provider>", "github or gitlab")
  .requiredOption("--repo <repo>", "repository to watch, e.g. owner/repo (github) or group/project (gitlab)")
  .option("--dir <path>", "directory to scaffold into", ".forgeflow")
  .option("--base-branch <name>", "base branch (default: current git branch, else main)")
  .option("--force", "overwrite existing files", false)
  .action(async (opts) => {
    if (opts.provider !== "github" && opts.provider !== "gitlab") {
      console.error(`Unknown provider "${opts.provider}" — expected "github" or "gitlab"`)
      process.exitCode = 1
      return
    }
    const { written, skipped } = runInit({
      provider: opts.provider,
      repo: opts.repo,
      dir: opts.dir,
      baseBranch: opts.baseBranch,
      force: opts.force,
    })
    for (const path of written) console.log(`created  ${path}`)
    for (const path of skipped) console.log(`skipped  ${path} (already exists, use --force to overwrite)`)
    console.log(`\nNext steps:
  1. cp ${opts.dir}/.env.example ${opts.dir}/.env and fill in your access token
  2. bash ${opts.dir}/build-image.sh
  3. npx forgeflow run --config ${opts.dir}/forgeflow.config.ts`)
  })

await program.parseAsync(process.argv)
