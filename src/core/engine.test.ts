import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createGateway } from "./engine.js"
import { sqliteState } from "../state/sqlite/index.js"
import { Match, defaultCommandId } from "./workflow.js"
import { allowAllTrustPolicy, denyAllTrustPolicy, fakeEnabledTarget, fakeEvent, fakeWorkflow } from "./testing/fakes.js"
import type { ForgeflowConfig } from "./config.js"

function makeConfig(overrides: Partial<ForgeflowConfig> = {}): ForgeflowConfig {
  return {
    state: sqliteState(":memory:"),
    enabledTargets: [],
    trustPolicy: allowAllTrustPolicy(),
    ...overrides,
  }
}

describe("ForgeflowGateway.poll", () => {
  it("accepts a matching event and queues a command", async () => {
    const workflow = fakeWorkflow("implement", { match: () => Match.accept() })
    const { target, adapter } = fakeEnabledTarget({ workflows: [workflow] })
    adapter.queuePoll([fakeEvent()])
    const gateway = createGateway(makeConfig({ enabledTargets: [target] }))

    const result = await gateway.poll()

    assert.deepEqual(result, { events: 1, commands: 1, deferred: 0, rejected: 0 })
  })

  it("does not process the same event twice", async () => {
    const workflow = fakeWorkflow("implement", { match: () => Match.accept() })
    const { target, adapter } = fakeEnabledTarget({ workflows: [workflow] })
    adapter.queuePoll([fakeEvent()])
    adapter.queuePoll([fakeEvent()]) // same event id, second poll batch
    const gateway = createGateway(makeConfig({ enabledTargets: [target] }))

    const first = await gateway.poll()
    const second = await gateway.poll()

    assert.equal(first.commands, 1)
    assert.equal(second.commands, 0)
    assert.equal(second.events, 1, "the event is still seen, just not re-accepted")
  })

  it("rejects an event when the trust policy denies it, without creating a command", async () => {
    const workflow = fakeWorkflow("implement", { match: () => Match.accept() })
    const { target, adapter } = fakeEnabledTarget({ workflows: [workflow] })
    adapter.queuePoll([fakeEvent()])
    const gateway = createGateway(makeConfig({ enabledTargets: [target], trustPolicy: denyAllTrustPolicy() }))

    const result = await gateway.poll()

    assert.deepEqual(result, { events: 1, commands: 0, deferred: 0, rejected: 1 })
  })

  it("creates a deferred command when the workflow defers, with a defer reason", async () => {
    const workflow = fakeWorkflow("implement", { match: () => Match.defer("blocked by #7") })
    const { target, adapter } = fakeEnabledTarget({ workflows: [workflow] })
    adapter.queuePoll([fakeEvent()])
    const gateway = createGateway(makeConfig({ enabledTargets: [target] }))

    const result = await gateway.poll()

    assert.deepEqual(result, { events: 1, commands: 0, deferred: 1, rejected: 0 })
  })

  it("ignores a second trigger for the same command while the first is still active", async () => {
    const workflow = fakeWorkflow("implement", { match: () => Match.accept() })
    const { target, adapter } = fakeEnabledTarget({ workflows: [workflow] })
    // Two distinct events (different ids) that resolve to the same command id (same label, same target).
    adapter.queuePoll([fakeEvent({ id: "evt-1" })])
    adapter.queuePoll([fakeEvent({ id: "evt-2" })])
    const gateway = createGateway(makeConfig({ enabledTargets: [target] }))

    const first = await gateway.poll()
    const second = await gateway.poll()

    assert.equal(first.commands, 1)
    assert.equal(second.commands, 0, "the command is already queued, so the second trigger is a no-op")
  })

  it("re-queues a command in place once it has reached a terminal status", async () => {
    const workflow = fakeWorkflow("implement", { match: () => Match.accept() })
    const { target, adapter } = fakeEnabledTarget({ workflows: [workflow] })
    adapter.queuePoll([fakeEvent({ id: "evt-1" })])
    const state = sqliteState(":memory:")
    const gateway = createGateway(makeConfig({ enabledTargets: [target], state }))

    await gateway.poll()
    await gateway.worker() // command reaches "succeeded"

    adapter.queuePoll([fakeEvent({ id: "evt-2" })]) // a fresh trigger for the same underlying command id
    const result = await gateway.poll()

    assert.equal(result.commands, 1, "a succeeded command can be re-triggered, not ignored forever")
  })
})

describe("ForgeflowGateway.worker", () => {
  it("marks a command succeeded when the workflow run completes", async () => {
    const workflow = fakeWorkflow("implement", { match: () => Match.accept(), run: async () => ({ summary: "implemented" }) })
    const { target, adapter } = fakeEnabledTarget({ workflows: [workflow] })
    adapter.queuePoll([fakeEvent()])
    const gateway = createGateway(makeConfig({ enabledTargets: [target] }))
    await gateway.poll()

    const result = await gateway.worker()

    assert.deepEqual(result, { processed: 1, succeeded: 1, failed: 0 })
  })

  it("marks a command failed when the workflow run throws", async () => {
    const workflow = fakeWorkflow("implement", { match: () => Match.accept(), run: async () => { throw new Error("sandbox blew up") } })
    const { target, adapter } = fakeEnabledTarget({ workflows: [workflow] })
    adapter.queuePoll([fakeEvent()])
    const gateway = createGateway(makeConfig({ enabledTargets: [target] }))
    await gateway.poll()

    const result = await gateway.worker()

    assert.deepEqual(result, { processed: 1, succeeded: 0, failed: 1 })
  })
})

describe("ForgeflowGateway deferred recheck", () => {
  // A single poll() call both processes new events AND rechecks any deferred command
  // that is already due — so the initial defer must land in the future (like real
  // production defers do via defaultDeferInterval) to avoid being rechecked within
  // the same call it was created in. Elapsing time is simulated by forcing
  // next_check_at into the past directly via the state store between poll() calls,
  // rather than waiting on the wall clock.
  const FAR_FUTURE = new Date(Date.now() + 3_600_000)
  const NOW_DUE = () => new Date(Date.now() - 1_000).toISOString()

  it("keeps a still-blocked command deferred instead of blindly promoting it once due", async () => {
    const workflow = fakeWorkflow("implement", { match: () => Match.defer({ reason: "still blocked", nextCheckAt: FAR_FUTURE }) })
    const { target, adapter } = fakeEnabledTarget({ workflows: [workflow] })
    const triggerEvent = fakeEvent()
    adapter.queuePoll([triggerEvent])
    const state = sqliteState(":memory:")
    const gateway = createGateway(makeConfig({ enabledTargets: [target], state }))

    const first = await gateway.poll()
    assert.deepEqual(first, { events: 1, commands: 0, deferred: 1, rejected: 0 }, "creating the deferred command does not also recheck it in the same pass")

    const commandId = defaultCommandId({ event: triggerEvent, workflowId: "implement" })
    await state.updateCommandStatus(commandId, "deferred", { nextCheckAt: NOW_DUE() })

    const second = await gateway.poll()
    assert.deepEqual(second, { events: 0, commands: 0, deferred: 1, rejected: 0 })
  })

  it("promotes a deferred command to queued once the workflow's matcher no longer defers it", async () => {
    let blocked = true
    const workflow = fakeWorkflow("implement", { match: () => blocked ? Match.defer({ reason: "still blocked", nextCheckAt: FAR_FUTURE }) : Match.accept() })
    const { target, adapter } = fakeEnabledTarget({ workflows: [workflow] })
    const triggerEvent = fakeEvent()
    adapter.queuePoll([triggerEvent])
    const state = sqliteState(":memory:")
    const gateway = createGateway(makeConfig({ enabledTargets: [target], state }))
    await gateway.poll()

    const commandId = defaultCommandId({ event: triggerEvent, workflowId: "implement" })
    await state.updateCommandStatus(commandId, "deferred", { nextCheckAt: NOW_DUE() })
    blocked = false // the blocker resolved while waiting

    const result = await gateway.poll()

    assert.deepEqual(result, { events: 0, commands: 1, deferred: 0, rejected: 0 })
    assert.equal((await state.getCommand(commandId))?.status, "queued")
  })

  it("marks a due deferred command rejected when its matcher now rejects it", async () => {
    let attempt = 0
    const workflow = fakeWorkflow("implement", {
      match: () => {
        attempt++
        return attempt === 1 ? Match.defer({ reason: "waiting", nextCheckAt: FAR_FUTURE }) : Match.reject("target was closed while waiting")
      },
    })
    const { target, adapter } = fakeEnabledTarget({ workflows: [workflow] })
    const triggerEvent = fakeEvent()
    adapter.queuePoll([triggerEvent])
    const state = sqliteState(":memory:")
    const gateway = createGateway(makeConfig({ enabledTargets: [target], state }))
    await gateway.poll()

    const commandId = defaultCommandId({ event: triggerEvent, workflowId: "implement" })
    await state.updateCommandStatus(commandId, "deferred", { nextCheckAt: NOW_DUE() })

    const result = await gateway.poll()

    assert.deepEqual(result, { events: 0, commands: 0, deferred: 0, rejected: 1 })
    assert.equal((await state.getCommand(commandId))?.status, "rejected")
  })
})

describe("ForgeflowGateway /agent retry", () => {
  it("re-queues the latest failed command for the same target", async () => {
    const workflow = fakeWorkflow("implement", { match: () => Match.accept(), run: async () => { throw new Error("boom") } })
    const { target, adapter } = fakeEnabledTarget({ workflows: [workflow] })
    const workTarget = fakeEvent().workTarget
    adapter.queuePoll([fakeEvent({ id: "evt-1" })])
    const gateway = createGateway(makeConfig({ enabledTargets: [target] }))
    await gateway.poll()
    await gateway.worker() // command reaches "failed"

    adapter.queuePoll([fakeEvent({ id: "evt-2", kind: "comment_created", workTarget, comment: { id: "c-1", body: "/agent retry" } })])
    const result = await gateway.poll()

    assert.equal(result.commands, 1)
  })

  it("is a no-op when there is no failed command for the target", async () => {
    const { target, adapter } = fakeEnabledTarget({ workflows: [] })
    adapter.queuePoll([fakeEvent({ kind: "comment_created", comment: { id: "c-1", body: "/agent retry" } })])
    const gateway = createGateway(makeConfig({ enabledTargets: [target] }))

    const result = await gateway.poll()

    assert.deepEqual(result, { events: 1, commands: 0, deferred: 0, rejected: 0 })
  })
})
