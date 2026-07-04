import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { drainUntilIdle, type RunOnceResult } from "./drain.js"

function result(commands: number, processed: number): RunOnceResult {
  return {
    poll: { events: commands, commands, deferred: 0, rejected: 0 },
    worker: { processed, succeeded: processed, failed: 0 },
  }
}

describe("drainUntilIdle", () => {
  it("runs until an iteration has no queued or processed work", async () => {
    const calls: Array<{ maxEvents?: number; limit?: number; parallel?: number }> = []
    const sequence = [result(1, 1), result(0, 1), result(0, 0)]

    const drained = await drainUntilIdle({
      async runOnce(options) {
        calls.push(options ?? {})
        return sequence[calls.length - 1] ?? result(0, 0)
      },
    }, { maxEvents: 50, parallel: 2, limit: 4, maxIterations: 5 })

    assert.equal(drained.idle, true)
    assert.equal(drained.iterations, 3)
    assert.equal(drained.results.length, 3)
    assert.deepEqual(calls, [
      { maxEvents: 50, parallel: 2, limit: 4 },
      { maxEvents: 50, parallel: 2, limit: 4 },
      { maxEvents: 50, parallel: 2, limit: 4 },
    ])
  })

  it("stops after maxIterations when work never drains", async () => {
    let calls = 0

    const drained = await drainUntilIdle({
      async runOnce() {
        calls++
        return result(1, 0)
      },
    }, { maxIterations: 2 })

    assert.equal(drained.idle, false)
    assert.equal(drained.iterations, 2)
    assert.equal(drained.results.length, 2)
    assert.equal(calls, 2)
  })
})
