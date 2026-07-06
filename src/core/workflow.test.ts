import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  Match,
  defineWorkflow,
  labelAdded,
  isChangeRequestKind,
  tagCreated,
  defaultCommandId,
  defaultWorkBranch,
  codeTargetFromEnabledTarget,
} from "./workflow.js"
import type { NormalizedEvent } from "./types.js"

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: "evt-1",
    provider: "github",
    source: "poll",
    provenance: "synthetic",
    kind: "label_added",
    workTarget: { provider: "github", repo: "acme/widgets", kind: "issue", id: "42" },
    occurredAt: "2026-01-01T00:00:00.000Z",
    observedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  }
}

describe("Match", () => {
  it("ignore() produces an ignore decision", () => {
    assert.deepEqual(Match.ignore(), { type: "ignore" })
  })

  it("reject() carries the reason", () => {
    assert.deepEqual(Match.reject("not applicable"), { type: "reject", reason: "not applicable" })
  })

  it("defer() accepts a bare reason string", () => {
    assert.deepEqual(Match.defer("waiting on CI"), { type: "defer", reason: "waiting on CI" })
  })

  it("defer() converts a Date nextCheckAt to an ISO string", () => {
    const decision = Match.defer({ reason: "blocked", nextCheckAt: new Date("2026-02-01T00:00:00.000Z") })
    assert.deepEqual(decision, { type: "defer", reason: "blocked", nextCheckAt: "2026-02-01T00:00:00.000Z" })
  })

  it("defer() passes through a string nextCheckAt unchanged", () => {
    const decision = Match.defer({ reason: "blocked", nextCheckAt: "2026-02-01T00:00:00.000Z" })
    assert.equal(decision.type === "defer" && decision.nextCheckAt, "2026-02-01T00:00:00.000Z")
  })

  it("accept() defaults to no title/body", () => {
    assert.deepEqual(Match.accept(), { type: "accept" })
  })

  it("accept() carries an optional title and body", () => {
    assert.deepEqual(Match.accept({ title: "Fix bug", body: "details" }), { type: "accept", title: "Fix bug", body: "details" })
  })
})

describe("defineWorkflow", () => {
  it("attaches the given id to the workflow", () => {
    const workflow = defineWorkflow("implement", { match: () => Match.ignore(), run: async () => {} })
    assert.equal(workflow.id, "implement")
  })
})

describe("labelAdded", () => {
  it("is true when a label_added event carries the matching label", () => {
    assert.equal(labelAdded(event({ kind: "label_added", label: "agent:implement" }), "agent:implement"), true)
  })

  it("is false when the label doesn't match", () => {
    assert.equal(labelAdded(event({ kind: "label_added", label: "agent:review" }), "agent:implement"), false)
  })

  it("is false for a non-label_added event kind", () => {
    assert.equal(labelAdded(event({ kind: "comment_created", label: "agent:implement" }), "agent:implement"), false)
  })
})

describe("isChangeRequestKind", () => {
  it("is true for pull_request and merge_request", () => {
    assert.equal(isChangeRequestKind("pull_request"), true)
    assert.equal(isChangeRequestKind("merge_request"), true)
  })

  it("is false for issue, tag, project, and repo", () => {
    assert.equal(isChangeRequestKind("issue"), false)
    assert.equal(isChangeRequestKind("tag"), false)
    assert.equal(isChangeRequestKind("project"), false)
    assert.equal(isChangeRequestKind("repo"), false)
  })
})

describe("tagCreated", () => {
  it("is true for a tag_created event with a tag name", () => {
    assert.equal(tagCreated(event({ kind: "tag_created", tag: "v1.2.3" })), true)
  })

  it("is false for a non-tag_created event", () => {
    assert.equal(tagCreated(event({ kind: "label_added", tag: "v1.2.3" })), false)
  })

  it("is false when the event has no tag name", () => {
    assert.equal(tagCreated(event({ kind: "tag_created", tag: undefined })), false)
  })

  it("respects a name pattern when provided", () => {
    assert.equal(tagCreated(event({ kind: "tag_created", tag: "v1.2.3" }), /^v\d/), true)
    assert.equal(tagCreated(event({ kind: "tag_created", tag: "not-a-version" }), /^v\d/), false)
  })
})

describe("defaultCommandId", () => {
  it("keys a label_added event by provider, repo, target, workflow, and label", () => {
    const id = defaultCommandId({ event: event({ kind: "label_added", label: "agent:implement" }), workflowId: "implement" })
    assert.equal(id, "github:acme/widgets:issue:42:implement:label:agent:implement")
  })

  it("keys a non-label event by its event kind instead of a label", () => {
    const id = defaultCommandId({ event: event({ kind: "tag_created", tag: "v1.0.0" }), workflowId: "publish" })
    assert.equal(id, "github:acme/widgets:issue:42:publish:tag_created")
  })

  it("falls back to project when repo is absent (GitLab-style targets)", () => {
    const gitlabEvent = event({ label: "agent:implement", workTarget: { provider: "gitlab", project: "group/project", kind: "issue", id: "7" } })
    const id = defaultCommandId({ event: gitlabEvent, workflowId: "implement" })
    assert.equal(id, "gitlab:group/project:issue:7:implement:label:agent:implement")
  })
})

describe("defaultWorkBranch", () => {
  it("builds a branch name from workflowId, target kind, and target id", () => {
    const branch = defaultWorkBranch({ workflowId: "implement", workTarget: { provider: "github", repo: "acme/widgets", kind: "issue", id: "42" } })
    assert.equal(branch, "agent/implement/issue-42")
  })

  it("sanitizes characters outside [A-Za-z0-9/_-]", () => {
    const branch = defaultWorkBranch({ workflowId: "implement", workTarget: { provider: "gitlab", project: "group/project", kind: "merge_request", id: "v1.2.3" } })
    assert.equal(branch, "agent/implement/merge_request-v1-2-3")
  })
})

describe("codeTargetFromEnabledTarget", () => {
  it("maps provider, codeRepo, and baseBranch to a CodeTargetRef", () => {
    const ref = codeTargetFromEnabledTarget({ provider: "github", codeRepo: "acme/widgets", baseBranch: "main" })
    assert.deepEqual(ref, { provider: "github", repo: "acme/widgets", baseBranch: "main" })
  })
})
