import { formatArtifactReference } from "../../../../core/io/index.js";
import type { RbtRecord } from "../record/rbt-record.js";
import type { ScoutDomainRuntimeFact } from "../../../types.js";
import type { RbtArtifactData, RbtExecutionHistory, RbtExecutionPackSubmission } from "../artifacts/types.js";
import type { RbtPlatform } from "../config/index.js";

export interface RbtDomainRuntimeData extends ScoutDomainRuntimeFact {
  domainId: "rbt";
  executionPlatform?: RbtPlatform;
  artifacts: RbtArtifactData;
}

/** Rebuilds RBT runtime facts without publishing historical events or executing commands. */
export class RbtDomainProjector {
  project(records: readonly RbtRecord[]): RbtDomainRuntimeData {
    const data: RbtDomainRuntimeData = {
      domainId: "rbt", journalSeq: 0,
      artifacts: { histories: new Map(), executionPacks: [], acceptedSubmissions: new Set() },
    };
    for (const record of records) {
      data.journalSeq = record.seq;
      data.updatedAt = record.occurredAt;
      switch (record.kind) {
        case "execution-source":
          if (data.executionPlatform && data.executionPlatform !== record.payload.platform) {
            throw new Error("RBT Workflow contains conflicting execution source selections.");
          }
          data.executionPlatform = record.payload.platform;
          break;
        case "execution-history": {
          const saved = record.payload;
          const history: RbtExecutionHistory = {
            bddId: saved.bddId, targetVersion: saved.targetVersion, platform: { ...saved.platform },
            executorHistoryRef: saved.executorHistoryRef, executorHistoryDigest: saved.executorHistoryDigest,
            executeFileRef: saved.executeFileRef, executeFileDigest: saved.executeFileDigest,
            runtimeSequence: saved.runtimeSequence, campaignId: saved.campaignId, scenarioId: saved.scenarioId,
            status: saved.status, agentId: saved.agentId, role: saved.role,
          };
          data.artifacts.histories.set(history.executorHistoryRef, { history, occurredAt: record.occurredAt });
          break;
        }
        case "execution-pack": {
          const saved = record.payload;
          const submission: RbtExecutionPackSubmission = {
            bddId: saved.bddId, targetVersion: saved.targetVersion, taskId: saved.taskId,
            stepId: saved.stepId, submittedAt: saved.submittedAt, pack: structuredClone(saved.pack),
          };
          data.artifacts.executionPacks.push(submission);
          data.artifacts.acceptedSubmissions.add(`${submission.taskId}\0${submission.stepId}\0${formatArtifactReference(submission.pack)}`);
          break;
        }
        case "review": {
          const saved = record.payload;
          data.artifacts.acceptedSubmissions.add(`${saved.taskId}\0${saved.stepId}\0${formatArtifactReference(saved.pack)}`);
          break;
        }
      }
    }
    return data;
  }
}
