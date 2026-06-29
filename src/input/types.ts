import type { ValidationBody, ValidationCatalog } from "./validation-body.js";

export interface ScoutInput {
  scoutInputId: string;
  runId: string;
  createdAt: string;
  validationBody: ValidationBody;
  validationCatalog: ValidationCatalog;
  inputProvenance: {
    researcherThreadId: string;
    assetCommitId: string;
    sourceRefs: string[];
  };
}
