export type RunOnceResult = {
  poll: { events: number; commands: number; deferred: number; rejected: number }
  worker: { processed: number; succeeded: number; failed: number }
}

export type RunOnceOptions = { maxEvents?: number; limit?: number; parallel?: number }

export type DrainIteration = {
  iteration: number
  maxIterations: number
  result: RunOnceResult
  didWork: boolean
}

export type DrainUntilIdleOptions = RunOnceOptions & {
  maxIterations?: number
  onIteration?: (iteration: DrainIteration) => void | Promise<void>
}

export type DrainUntilIdleResult = {
  idle: boolean
  iterations: number
  results: RunOnceResult[]
}

export type RunOnceGateway = {
  runOnce(options?: RunOnceOptions): Promise<RunOnceResult>
}

export async function drainUntilIdle(gateway: RunOnceGateway, options: DrainUntilIdleOptions = {}): Promise<DrainUntilIdleResult> {
  const maxIterations = options.maxIterations ?? 20
  const results: RunOnceResult[] = []

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const result = await gateway.runOnce({ maxEvents: options.maxEvents, parallel: options.parallel, limit: options.limit })
    const didWork = result.poll.commands > 0 || result.worker.processed > 0
    results.push(result)

    await options.onIteration?.({ iteration, maxIterations, result, didWork })

    if (!didWork) {
      return { idle: true, iterations: iteration, results }
    }
  }

  return { idle: false, iterations: maxIterations, results }
}
