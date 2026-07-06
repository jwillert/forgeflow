import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { validateReviewOutput, validateUpdateBranchOutput, parseDiffLines, filterInlineComments, filterReplies } from "./review-output.js"

describe("validateReviewOutput", () => {
  it("parses a fully-populated review output", () => {
    const output = validateReviewOutput({
      summary: "Looks good",
      inlineComments: [{ path: "src/a.ts", line: 12, body: "nit: rename this" }],
      replies: [{ threadId: "thread-1", body: "addressed" }],
    })
    assert.deepEqual(output, {
      summary: "Looks good",
      inlineComments: [{ path: "src/a.ts", line: 12, body: "nit: rename this" }],
      replies: [{ threadId: "thread-1", body: "addressed" }],
    })
  })

  it("defaults inlineComments and replies to empty arrays when absent", () => {
    const output = validateReviewOutput({ summary: "Clean" })
    assert.deepEqual(output.inlineComments, [])
    assert.deepEqual(output.replies, [])
  })

  it("throws when summary is missing", () => {
    assert.throws(() => validateReviewOutput({}), /summary must be a non-empty string/)
  })

  it("accepts file/comment as aliases for path/body on inline comments", () => {
    const output = validateReviewOutput({ summary: "x", inlineComments: [{ file: "src/b.ts", line: 3, comment: "alias form" }] })
    assert.deepEqual(output.inlineComments, [{ path: "src/b.ts", line: 3, body: "alias form" }])
  })

  it("derives the line from lineRange when line is absent", () => {
    const output = validateReviewOutput({ summary: "x", inlineComments: [{ path: "src/c.ts", lineRange: "10-15", body: "range" }] })
    assert.equal(output.inlineComments[0].line, 10)
  })

  it("throws when neither line nor a usable lineRange is present", () => {
    assert.throws(() => validateReviewOutput({ summary: "x", inlineComments: [{ path: "src/c.ts", body: "no line info" }] }))
  })

  it("accepts commentId as an alias for threadId on replies", () => {
    const output = validateReviewOutput({ summary: "x", replies: [{ commentId: "thread-2", comment: "alias reply" }] })
    assert.deepEqual(output.replies, [{ threadId: "thread-2", body: "alias reply" }])
  })
})

describe("validateUpdateBranchOutput", () => {
  it("parses a comment", () => {
    assert.deepEqual(validateUpdateBranchOutput({ comment: "merged cleanly" }), { comment: "merged cleanly" })
  })

  it("throws when comment is missing", () => {
    assert.throws(() => validateUpdateBranchOutput({}), /comment must be a non-empty string/)
  })
})

describe("parseDiffLines", () => {
  it("maps added and context lines to their new-file line numbers, per file", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,3 +10,4 @@",
      " unchanged line",
      "+added line",
      " another unchanged line",
      "-removed line",
    ].join("\n")

    const diffLines = parseDiffLines(diff)
    assert.deepEqual(diffLines.get("src/a.ts"), new Set([10, 11, 12]))
  })

  it("tracks separate line sets per file across a multi-file diff", () => {
    const diff = [
      "+++ b/src/a.ts",
      "@@ -1,1 +1,2 @@",
      "+line one",
      "+++ b/src/b.ts",
      "@@ -5,1 +5,2 @@",
      "+line two",
    ].join("\n")

    const diffLines = parseDiffLines(diff)
    assert.deepEqual(diffLines.get("src/a.ts"), new Set([1]))
    assert.deepEqual(diffLines.get("src/b.ts"), new Set([5]))
  })

  it("returns an empty map for a diff with no file headers", () => {
    assert.deepEqual(parseDiffLines("not a diff"), new Map())
  })
})

describe("filterInlineComments", () => {
  it("keeps only comments whose path+line exist in the diff", () => {
    const diffLines = new Map([["src/a.ts", new Set([10, 11])]])
    const comments = [
      { path: "src/a.ts", line: 10, body: "in diff" },
      { path: "src/a.ts", line: 99, body: "not in diff" },
      { path: "src/other.ts", line: 10, body: "wrong file" },
    ]
    assert.deepEqual(filterInlineComments(comments, diffLines), [{ path: "src/a.ts", line: 10, body: "in diff" }])
  })
})

describe("filterReplies", () => {
  it("keeps only replies whose threadId is in the valid set", () => {
    const validReplyIds = new Set(["thread-1"])
    const replies = [
      { threadId: "thread-1", body: "kept" },
      { threadId: "thread-unknown", body: "dropped" },
    ]
    assert.deepEqual(filterReplies(replies, validReplyIds), [{ threadId: "thread-1", body: "kept" }])
  })
})
