import { config as loadEnv } from "dotenv"
import { createEnvReader, createGateway, drainUntilIdle } from "forgeflow"
import configFactory from "./forgeflow.config.js"

loadEnv({ path: ".forgeflow/.env" })
process.env.GH_REPO ??= process.env.FORGEFLOW_GITHUB_REPO

const config = await configFactory({ env: createEnvReader() })
const gateway = createGateway(config)

const maxIterations = Number(process.env.FORGEFLOW_DRAIN_MAX_ITERATIONS ?? 20)
const maxEvents = Number(process.env.FORGEFLOW_MAX_EVENTS ?? 100)
const parallel = Number(process.env.FORGEFLOW_PARALLEL ?? 3)
const limit = process.env.FORGEFLOW_LIMIT ? Number(process.env.FORGEFLOW_LIMIT) : undefined

const result = await drainUntilIdle(gateway, {
  maxIterations,
  maxEvents,
  parallel,
  limit,
  onIteration: ({ iteration, maxIterations, result }) => {
    console.log(`\n=== Forgeflow drain iteration ${iteration}/${maxIterations} ===`)
    console.log(JSON.stringify(result, null, 2))
  },
})

if (result.idle) {
  console.log("Forgeflow idle.")
  process.exit(0)
}

console.log(`Forgeflow drain stopped after ${maxIterations} iteration(s).`)
