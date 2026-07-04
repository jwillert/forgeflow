import { runProcessOrThrow } from "forgeflow"

export async function gh(args: string[], input?: string): Promise<string> {
  const result = await runProcessOrThrow({
    command: "gh",
    args,
    env: input === undefined ? undefined : { GH_STDIN: input },
  })
  return result.stdout.trim()
}

export async function ghJson<T>(args: string[]): Promise<T> {
  const stdout = await gh(args)
  return JSON.parse(stdout) as T
}

export async function ghApiJson<T>(path: string, args: string[] = []): Promise<T> {
  return await ghJson<T>(["api", path, ...args])
}

export async function addPrLabel(prNumber: string, label: string): Promise<void> {
  await gh(["pr", "edit", prNumber, "--add-label", label])
}

export async function removePrLabel(prNumber: string, label: string): Promise<void> {
  await gh(["pr", "edit", prNumber, "--remove-label", label]).catch(() => undefined)
}

export async function commentPr(prNumber: string, body: string): Promise<void> {
  await gh(["pr", "comment", prNumber, "--body", body])
}
