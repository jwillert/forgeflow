import { runProcessOrThrow } from "forgeflow"

export async function git(args: string[], options: { cwd?: string } = {}): Promise<string> {
  const result = await runProcessOrThrow({ command: "git", args, cwd: options.cwd })
  return result.stdout.trim()
}

export async function configureBotGit(cwd?: string): Promise<void> {
  await git(["config", "user.name", "forgeflow[bot]"], { cwd })
  await git(["config", "user.email", "forgeflow[bot]@users.noreply.github.com"], { cwd })
}

export async function checkoutWorkBranch(input: { baseRef: string; workBranch: string; cwd?: string }): Promise<void> {
  await git(["fetch", "origin", `${input.baseRef}:${input.baseRef}`], { cwd: input.cwd }).catch(() => git(["fetch", "origin", input.baseRef], { cwd: input.cwd }))
  await git(["checkout", input.baseRef], { cwd: input.cwd })
  await git(["pull", "--ff-only", "origin", input.baseRef], { cwd: input.cwd })
  await git(["checkout", "-B", input.workBranch], { cwd: input.cwd })
  await configureBotGit(input.cwd)
}

export async function commitsAhead(input: { baseRef: string; cwd?: string }): Promise<number> {
  const count = await git(["rev-list", "--count", `${input.baseRef}..HEAD`], { cwd: input.cwd })
  return Number(count.trim())
}

export async function pushBranch(input: { branch: string; cwd?: string; forceWithLease?: string }): Promise<void> {
  if (input.forceWithLease) {
    await git(["push", `--force-with-lease=${input.forceWithLease}`, "origin", input.branch], { cwd: input.cwd })
  } else {
    await git(["push", "--force", "origin", input.branch], { cwd: input.cwd })
  }
}
