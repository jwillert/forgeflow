import type { WorkTracker } from "../../core/capabilities.js"
import type { WorkTargetRef } from "../../core/types.js"
import type { WorkflowRunResult } from "../../core/workflow.js"

export interface AgentLifecycleLabels {
  readonly trigger: string
  readonly blocked?: string
  readonly inProgress?: string
}

/**
 * Wraps a workflow body with the label/comment dance every agent workflow needs:
 * clear the trigger + blocked labels, mark in-progress, run the body, and on
 * failure add the blocked label back with a comment explaining how to retry.
 * The body should simply throw on failure — this is the only place that turns
 * an error into the blocked label + comment, so workflows can't double-report
 * the same failure by also handling it themselves.
 */
export async function runWithAgentLifecycle(
  input: { workTracker: WorkTracker; target: WorkTargetRef; labels: AgentLifecycleLabels },
  body: () => Promise<WorkflowRunResult | void>,
): Promise<WorkflowRunResult | void> {
  const { workTracker, target, labels } = input
  const blockedLabel = labels.blocked ?? "agent:blocked"
  const inProgressLabel = labels.inProgress ?? "agent:in-progress"

  await workTracker.removeLabel(target, labels.trigger).catch(() => undefined)
  await workTracker.removeLabel(target, blockedLabel).catch(() => undefined)
  await workTracker.addLabel(target, inProgressLabel)

  try {
    return await body()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await workTracker.addLabel(target, blockedLabel).catch(() => undefined)
    await workTracker.addComment(
      target,
      `\`${labels.trigger}\` run failed.\n\n**Reason:** ${message}\n\nRe-add \`${labels.trigger}\` or comment \`/agent retry\` to retry.`,
    ).catch(() => undefined)
    throw error
  } finally {
    await workTracker.removeLabel(target, inProgressLabel).catch(() => undefined)
  }
}
