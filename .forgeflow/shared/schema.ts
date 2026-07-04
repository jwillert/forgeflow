import type { StandardSchemaV1 } from "@standard-schema/spec"

export const standardSchema = <T>(validate: (value: unknown) => T): StandardSchemaV1<unknown, T> => ({
  "~standard": {
    version: 1,
    vendor: "forgeflow-local-workflows",
    validate: (value: unknown) => {
      try {
        return { value: validate(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : "Validation failed" }] }
      }
    },
  },
})

export const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

export const asOptionalString = (value: unknown): string | undefined => typeof value === "string" && value.trim().length > 0 ? value : undefined

export const asArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}
