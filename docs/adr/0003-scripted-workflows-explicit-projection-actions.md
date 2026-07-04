# Scripted workflows with explicit projection actions

Forgeflow workflows script provider-facing projection actions explicitly, such as adding/removing labels, writing comments, and opening/updating change requests; the engine does not automatically project queued/running/failed/done lifecycle labels or comments. We chose this over lifecycle aliases and configuration-driven projections because labels and comments can themselves trigger other workflows, and explicit scripted actions make provider side effects visible while keeping internal command and workflow-run state transitions automatic.
