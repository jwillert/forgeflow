import { cpSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, "../src/workflows/prompts")
const dest = join(here, "../dist/workflows/prompts")

cpSync(src, dest, { recursive: true })
