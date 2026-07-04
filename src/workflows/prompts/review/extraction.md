Emit a single `<output>` block as the last thing in your response.

Do not change files.
Do not run commands.
Do not include text outside the `<output>` block.
Do not wrap the `<output>` block in a markdown code fence (no ``` before or after it) — the JSON goes directly between the tags.

<output>
{
  "summary": "1-3 paragraphs explaining your review, including what you changed or why it was already clean.",
  "inlineComments": [
    { "path": "relative/file.ts", "line": 123, "body": "Markdown comment" }
  ],
  "replies": [
    { "threadId": "the \"id\" of a thread from review_threads in PR_COMMENTS_JSON", "body": "Markdown reply" }
  ]
}
</output>

Use empty arrays when there are no inline comments or replies.
Even if there is nothing to change or add, still emit the full JSON object above with an empty summary-appropriate message — never reply with plain prose instead of the `<output>` block.
