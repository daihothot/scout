import { basename, resolve, sep } from "node:path";
import { readJsonFile } from "../core/fs.js";
import type { ScoutInput } from "./types.js";
import { validateValidationBody } from "./validation-body.js";

export function loadScoutInput(path: string): ScoutInput {
  if (basename(path) !== "scout-input.json") {
    throw new Error("--scout-input must point to a Researcher artifact scout-input.json file.");
  }
  const scoutInput = readJsonFile<ScoutInput>(path);
  const normalizedPath = resolve(path);
  const artifactSegment = `${sep}run${sep}${scoutInput.runId}${sep}agents${sep}`;
  if (!normalizedPath.includes(artifactSegment) || !normalizedPath.includes(`${sep}agents${sep}researcher${sep}artifacts${sep}`)) {
    throw new Error("--scout-input must be produced under run/<run-id>/agents/researcher/artifacts/.");
  }
  const errors = validateValidationBody(scoutInput.validationBody, scoutInput.validationCatalog);
  if (errors.length > 0) {
    throw new Error([
      `Invalid Scout Input: ${path}`,
      ...errors.map((error) => `- ${error}`),
    ].join("\n"));
  }
  if (!scoutInput.inputProvenance?.researcherThreadId) {
    throw new Error("--scout-input must include inputProvenance.researcherThreadId from the Researcher input flow.");
  }
  if (!scoutInput.runId.startsWith("run-")) {
    throw new Error("--scout-input must include a run-* runId produced by the Researcher input flow.");
  }
  return scoutInput;
}
