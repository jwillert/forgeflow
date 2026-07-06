# Deferred commands re-run the workflow matcher, not a blind requeue

A due Deferred agent command re-runs its workflow's matcher against the original triggering event before requeuing, instead of flipping straight to `queued`. We chose this because a defer condition (e.g. a Blocking Issue) can still hold when the timer elapses; blindly requeuing would silently start work the matcher would no longer accept. The requeue happens against the stored `triggerEvent`, so the matcher sees current state (an issue may have closed, a blocker resolved) rather than the state at defer time.
