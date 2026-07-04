import { cpSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")

cpSync(join(root, "src/workflows/prompts"), join(root, "dist/workflows/prompts"), { recursive: true })
cpSync(join(root, "src/cli/templates"), join(root, "dist/cli/templates"), { recursive: true })
