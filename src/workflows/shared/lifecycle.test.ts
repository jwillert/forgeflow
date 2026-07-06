import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { runWithAgentLifecycle } from "./lifecycle.js"
import type { WorkTracker } from "../../core/capabilities.js"
import type { WorkTargetRef } from "../../core/types.js"

type Call =
  | { op: "addLabel"; label: string }
  | { op: "removeLabel"; label: string }
  | { op: "addComment"; body: string }

class FakeWorkTracker implements WorkTracker {
  readonly calls: Call[] = []
  private addLabelFailures = new Map<string, Error>()

  async getTarget(target: WorkTargetRef) {
    return { target, labels: [] }
  }
  async listBlockingIssues(): Promise<WorkTargetRef[]> {
    return []
  }
  async addLabel(_target: WorkTargetRef, label: string): Promise<void> {
    this.calls.push({ op: "addLabel", label })
    const failure = this.addLabelFailures.get(label)
    if (failure) throw failure
  }
  async removeLabel(_target: WorkTargetRef, label: string): Promise<void> {
    this.calls.push({ op: "removeLabel", label })
  }
  async addComment(_target: WorkTargetRef, body: string) {
    this.calls.push({ op: "addComment", body })
    return { id: "comment-1" }
  }
  failAddLabel(label: string, error: Error) {
    this.addLabelFailures.set(label, error)
  }
}

const target: WorkTargetRef = { provider: "github", repo: "acme/widgets", kind: "issue", id: "42" }

describe("runWithAgentLifecycle", () => {
  it("clears the trigger and blocked labels, marks in-progress, then cleans up in-progress on success", async () => {
    const workTracker = new FakeWorkTracker()

    const result = await runWithAgentLifecycle(
      { workTracker, target, labels: { trigger: "agent:implement" } },
      async () => ({ summary: "done" }),
    )

    assert.deepEqual(result, { summary: "done" })
    assert.deepEqual(workTracker.calls, [
      { op: "removeLabel", label: "agent:implement" },
      { op: "removeLabel", label: "agent:blocked" },
      { op: "addLabel", label: "agent:in-progress" },
      { op: "removeLabel", label: "agent:in-progress" },
    ])
  })

  it("respects custom blocked/inProgress label overrides", async () => {
    const workTracker = new FakeWorkTracker()

    await runWithAgentLifecycle(
      { workTracker, target, labels: { trigger: "agent:implement", blocked: "custom:blocked", inProgress: "custom:running" } },
      async () => undefined,
    )

    assert.deepEqual(workTracker.calls, [
      { op: "removeLabel", label: "agent:implement" },
      { op: "removeLabel", label: "custom:blocked" },
      { op: "addLabel", label: "custom:running" },
      { op: "removeLabel", label: "custom:running" },
    ])
  })

  it("adds the blocked label and a failure comment, then re-throws, when the body fails", async () => {
    const workTracker = new FakeWorkTracker()

    await assert.rejects(
      runWithAgentLifecycle(
        { workTracker, target, labels: { trigger: "agent:implement" } },
        async () => { throw new Error("no commits were made") },
      ),
      /no commits were made/,
    )

    assert.deepEqual(workTracker.calls.map(c => c.op), ["removeLabel", "removeLabel", "addLabel", "addLabel", "addComment", "removeLabel"])
    assert.deepEqual(workTracker.calls[3], { op: "addLabel", label: "agent:blocked" })
    assert.deepEqual(workTracker.calls[5], { op: "removeLabel", label: "agent:in-progress" })
  })

  it("the failure comment names the trigger label and includes the error message and retry instructions", async () => {
    const workTracker = new FakeWorkTracker()

    await assert.rejects(runWithAgentLifecycle(
      { workTracker, target, labels: { trigger: "agent:implement" } },
      async () => { throw new Error("no commits were made") },
    ))

    const comment = workTracker.calls.find((c): c is Call & { op: "addComment" } => c.op === "addComment")
    assert.ok(comment, "expected a failure comment to be posted")
    assert.match(comment.body, /`agent:implement` run failed/)
    assert.match(comment.body, /no commits were made/)
    assert.match(comment.body, /Re-add `agent:implement` or comment `\/agent retry`/)
  })

  it("still re-throws the original error even if posting the failure comment itself fails", async () => {
    const workTracker = new FakeWorkTracker()
    workTracker.addComment = async () => { throw new Error("network error posting comment") }

    await assert.rejects(
      runWithAgentLifecycle(
        { workTracker, target, labels: { trigger: "agent:implement" } },
        async () => { throw new Error("original failure") },
      ),
      /original failure/,
    )
  })

  it("propagates a failure to add the initial in-progress label without running the body", async () => {
    const workTracker = new FakeWorkTracker()
    workTracker.failAddLabel("agent:in-progress", new Error("label API down"))
    let bodyRan = false

    await assert.rejects(
      runWithAgentLifecycle(
        { workTracker, target, labels: { trigger: "agent:implement" } },
        async () => { bodyRan = true },
      ),
      /label API down/,
    )

    assert.equal(bodyRan, false)
  })
})
