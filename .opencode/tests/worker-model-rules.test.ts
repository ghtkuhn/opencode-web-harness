import assert from "node:assert/strict"
import { test } from "node:test"
import {
  matchingWorkerModelFamily,
  workerModelFamiliesFromConfig,
} from "../lib/worker-model-rules.ts"

test("matches a configured family against a normalized model identity", () => {
  const families = workerModelFamiliesFromConfig({
    GEMMA4: { matches: ["gemma4"], rulesFile: "WORKER-GEMMA4.md", requireRead: true },
  })

  assert.equal(
    matchingWorkerModelFamily("hightrail-local/gemma4:12b-it-q8", families)?.family,
    "GEMMA4",
  )
  assert.equal(matchingWorkerModelFamily("hightrail-local/gemma-4:12b-it-q8", families)?.rulesFile, "WORKER-GEMMA4.md")
  assert.equal(matchingWorkerModelFamily("hightrail-local/gemma4:12b-it-q8", families)?.requireRead, true)
})

test("ignores common model-name separators when matching a family", () => {
  const families = workerModelFamiliesFromConfig({
    GEMMA4: { matches: ["gemma4"], rulesFile: "WORKER-GEMMA4.md" },
  })

  for (const identity of [
    "provider/gemma-4-12b",
    "provider/gemma_4_12b",
    "provider/gemma:4:12b",
    "provider/gemma.4.12b",
  ]) {
    assert.equal(matchingWorkerModelFamily(identity, families)?.family, "GEMMA4")
  }
})

test("loads only the most specific matching family", () => {
  const families = workerModelFamiliesFromConfig({
    GEMMA: { matches: ["gemma"] },
    GEMMA4: { matches: ["gemma4"] },
  })

  assert.equal(matchingWorkerModelFamily("provider/gemma4:12b", families)?.family, "GEMMA4")
  assert.equal(matchingWorkerModelFamily("provider/qwen3.6:27b", families), null)
  assert.equal(families[0].requireRead, false)
})

test("rejects family files outside the root naming convention", () => {
  assert.throws(
    () => workerModelFamiliesFromConfig({ GEMMA4: { rulesFile: "rules/GEMMA4.md" } }),
    /WORKER-<FAMILY>/,
  )
})
