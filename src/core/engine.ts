import { createCommandState, type StateStore } from "./state.js"
import type { AgentCommand, NormalizedEvent } from "./types.js"
import { codeTargetFromEnabledTarget, defaultCommandId, type Workflow } from "./workflow.js"
import type { EnabledTarget, ForgeflowConfig } from "./config.js"
import { defaultTrustPolicy } from "./config.js"

function nowIso() { return new Date().toISOString() }

function isActiveStatus(status: import("./types.js").AgentCommandStatus): boolean {
  return status === "queued" || status === "deferred" || status === "running"
}

function workTargetKey(target: import("./types.js").WorkTargetRef): string {
  return `${target.provider}:${target.repo ?? target.project ?? ""}:${target.kind}:${target.id}`
}

function addInterval(from: Date, interval = "15m"): string {
  const match = /^(\d+)\s*([smhd])$/.exec(interval)
  if (!match) return new Date(from.getTime() + 15 * 60_000).toISOString()
  const n = Number(match[1])
  const unit = match[2]
  const ms = unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000
  return new Date(from.getTime() + ms).toISOString()
}

export class ForgeflowGateway {
  constructor(private readonly config: ForgeflowConfig) {}

  async runOnce(options: { maxEvents?: number; limit?: number; parallel?: number } = {}): Promise<{ poll: { events: number; commands: number; deferred: number; rejected: number }; worker: { processed: number; succeeded: number; failed: number } }> {
    const poll = await this.poll({ maxEvents: options.maxEvents })
    const worker = await this.worker({ limit: options.limit, parallel: options.parallel })
    return { poll, worker }
  }

  async poll(options: { maxEvents?: number } = {}): Promise<{ events: number; commands: number; deferred: number; rejected: number }> {
    const maxEvents = options.maxEvents ?? 100
    let budget = maxEvents
    let eventsSeen = 0, commands = 0, deferred = 0, rejected = 0

    for (const target of this.config.enabledTargets) {
      if (budget <= 0) break
      const sourceKey = `${target.provider}:${target.id}`
      const cursor = await this.config.state.getCursor(sourceKey)
      const batch = await target.pollingSource.poll({ cursor, maxEvents: budget })
      for (const event of batch.events) {
        if (budget <= 0) break
        budget--
        eventsSeen++
        const result = await this.handleEvent(target, event)
        if (result === "accepted") commands++
        if (result === "deferred") deferred++
        if (result === "rejected") rejected++
      }
      await this.config.state.setCursor(sourceKey, batch.nextCursor)
    }

    if (budget > 0) {
      const due = await this.config.state.listDueDeferred(nowIso(), budget)
      for (const command of due) {
        budget--
        // MVP requeues deferred commands on due time. Match re-evaluation can become richer later.
        await this.config.state.updateCommandStatus(command.id, "queued")
        commands++
      }
    }

    return { events: eventsSeen, commands, deferred, rejected }
  }

  private async handleEvent(target: EnabledTarget, event: NormalizedEvent): Promise<"ignored" | "accepted" | "deferred" | "rejected"> {
    if (await this.config.state.hasProcessedEvent(event.id)) return "ignored"
    await this.config.state.recordEvent(event, { rawPayload: this.config.eventAudit?.storeRawPayloads ? event.raw : undefined })

    if (event.kind === "comment_created" && event.comment?.body.trim() === "/agent retry") {
      const failed = await this.config.state.findLatestFailedCommandForTarget(workTargetKey(event.workTarget))
      if (failed) await this.config.state.updateCommandStatus(failed.id, "queued")
      await this.config.state.markEventProcessed(event.id)
      return failed ? "accepted" : "ignored"
    }

    const trust = await (this.config.trustPolicy ?? defaultTrustPolicy()).canProcessEvent({ event })
    if (!trust.allowed) {
      await this.config.state.markEventProcessed(event.id)
      return "rejected"
    }

    for (const workflow of target.workflows) {
      const decision = await workflow.match({
        event,
        workReader: target.workReader,
        codeReader: target.codeReader,
        state: this.config.state,
        trustPolicy: this.config.trustPolicy ?? defaultTrustPolicy(),
      })
      if (decision.type === "ignore") continue

      const commandId = defaultCommandId({ event, workflowId: workflow.id })
      if (decision.type === "reject") {
        await this.config.state.markEventProcessed(event.id)
        return "rejected"
      }

      const existing = await this.config.state.getCommand(commandId)
      if (existing && isActiveStatus(existing.status)) {
        await this.config.state.markEventProcessed(event.id)
        return "ignored"
      }
      if (existing) {
        // Prior run for this trigger reached a terminal state (succeeded/failed/rejected);
        // re-queue it in place rather than creating a duplicate command with the same id.
        await this.config.state.updateCommandStatus(commandId, decision.type === "defer" ? "deferred" : "queued", {
          reason: decision.type === "defer" ? decision.reason : undefined,
          nextCheckAt: decision.type === "defer" ? decision.nextCheckAt ?? addInterval(new Date(), this.config.defaultDeferInterval).toString() : undefined,
        })
        await this.config.state.markEventProcessed(event.id)
        return decision.type === "defer" ? "deferred" : "accepted"
      }

      const snapshot = await target.workReader.getTarget(event.workTarget).catch(() => undefined)
      const createdAt = nowIso()
      const command: AgentCommand = {
        id: commandId,
        workflowId: workflow.id,
        triggerEvent: event,
        workTarget: event.workTarget,
        codeTarget: codeTargetFromEnabledTarget(target),
        title: decision.type === "accept" && decision.title ? decision.title : snapshot?.title ?? `${workflow.id} for ${event.workTarget.kind} ${event.workTarget.id}`,
        body: decision.type === "accept" && decision.body ? decision.body : snapshot?.body,
        status: decision.type === "defer" ? "deferred" : "queued",
        deferReason: decision.type === "defer" ? decision.reason : undefined,
        nextCheckAt: decision.type === "defer" ? decision.nextCheckAt ?? addInterval(new Date(), this.config.defaultDeferInterval).toString() : undefined,
        createdAt,
        updatedAt: createdAt,
      }
      await this.config.state.createCommand(command)
      await this.config.state.markEventProcessed(event.id)
      return decision.type === "defer" ? "deferred" : "accepted"
    }

    await this.config.state.markEventProcessed(event.id)
    return "ignored"
  }

  async worker(options: { limit?: number; parallel?: number } = {}): Promise<{ processed: number; succeeded: number; failed: number }> {
    const parallel = Math.max(1, options.parallel ?? 3)
    const limit = options.limit ?? parallel
    const commands = await this.config.state.claimQueued(limit)
    let succeeded = 0, failed = 0

    for (let index = 0; index < commands.length; index += parallel) {
      const batch = commands.slice(index, index + parallel)
      const settled = await Promise.allSettled(batch.map(command => this.runCommand(command)))
      for (const outcome of settled) {
        if (outcome.status === "fulfilled" && outcome.value === "succeeded") succeeded++
        else failed++
      }
    }

    return { processed: commands.length, succeeded, failed }
  }

  private async runCommand(command: AgentCommand): Promise<"succeeded" | "failed"> {
    const target = this.findTargetForCommand(command)
    const workflow = target?.workflows.find(w => w.id === command.workflowId)
    if (!target || !workflow) {
      await this.config.state.updateCommandStatus(command.id, "failed", { reason: "No enabled target/workflow found" })
      return "failed"
    }

    const startedAt = nowIso()
    await this.config.state.recordWorkflowRun({ commandId: command.id, workflowId: command.workflowId, status: "running", startedAt })
    try {
      const result = await workflow.run({
        command,
        workTracker: target.workTracker,
        codeHost: target.codeHost,
        commandState: createCommandState(this.config.state, command.id),
        capabilities: { optional: <T>(name: string) => this.config.capabilities?.[name] as T | undefined },
      })
      await this.config.state.updateCommandStatus(command.id, "succeeded")
      await this.config.state.recordWorkflowRun({ commandId: command.id, workflowId: command.workflowId, status: "succeeded", startedAt, completedAt: nowIso(), summary: result?.summary })
      return "succeeded"
    } catch (error) {
      await this.config.state.updateCommandStatus(command.id, "failed", { reason: error instanceof Error ? error.message : String(error) })
      await this.config.state.recordWorkflowRun({ commandId: command.id, workflowId: command.workflowId, status: "failed", startedAt, completedAt: nowIso(), error: error instanceof Error ? error.stack ?? error.message : String(error) })
      return "failed"
    }
  }

  private findTargetForCommand(command: AgentCommand): EnabledTarget | undefined {
    return this.config.enabledTargets.find(t => t.provider === command.codeTarget.provider && t.codeRepo === command.codeTarget.repo)
  }
}

export function createGateway(config: ForgeflowConfig) {
  return new ForgeflowGateway(config)
}
