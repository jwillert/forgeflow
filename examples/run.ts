import { createEnvReader, createGateway } from "forgeflow"
import configFactory from "./forgeflow.config"

const config = await configFactory({ env: createEnvReader() })
const gateway = createGateway(config)

const result = await gateway.runOnce({
  maxEvents: Number(process.env.FORGEFLOW_MAX_EVENTS ?? 100),
  parallel: Number(process.env.FORGEFLOW_PARALLEL ?? 3),
  limit: process.env.FORGEFLOW_LIMIT ? Number(process.env.FORGEFLOW_LIMIT) : undefined,
})

console.log(JSON.stringify(result, null, 2))
