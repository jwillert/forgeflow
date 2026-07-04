import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function tryAcquire(lockPath: string): boolean {
  mkdirSync(dirname(lockPath), { recursive: true })
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8").trim())
    if (pid && isProcessAlive(pid)) return false
  }
  writeFileSync(lockPath, String(process.pid))
  return true
}

/** Runs `fn` under an advisory PID-file lock at `lockPath`. Fails fast if already held. */
export async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  if (!tryAcquire(lockPath)) {
    throw new Error(`Another forgeflow run holds the lock at ${lockPath}. Skipping.`)
  }
  try {
    return await fn()
  } finally {
    try { rmSync(lockPath) } catch { /* already gone */ }
  }
}

/** Same as withLock, but waits (polling) for the lock to free up instead of failing immediately. */
export async function withLockBlocking<T>(lockPath: string, fn: () => Promise<T>, timeoutMs = 10 * 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (!tryAcquire(lockPath)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock at ${lockPath}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  try {
    return await fn()
  } finally {
    try { rmSync(lockPath) } catch { /* already gone */ }
  }
}
