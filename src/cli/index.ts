#!/usr/bin/env node
import { Command } from "commander"
import { pathToFileURL } from "node:url"
import { extname, resolve } from "node:path"
import { tsImport } from "tsx/esm/api"
import { createGateway } from "../core/engine.js"
import { createEnvReader, type ForgeflowConfig } from "../core/config.js"

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

await program.parseAsync(process.argv)
