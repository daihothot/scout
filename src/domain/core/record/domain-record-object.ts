import type { EventType } from "../../../core/events/index.js";
import { recordObjectPaths } from "../../../core/path.js";
import { RecordableObject, type RecordEvent, type RecordWriteFailure } from "../../../core/record/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import type { ScoutDomainId } from "../../types.js";

/** Common recording lifecycle; Domain projections remain defined by their own producers. */
export abstract class DomainRecordObject<TRecord extends RecordEvent = RecordEvent> extends RecordableObject<TRecord> {
  abstract readonly eventTypes: readonly EventType[];

  protected constructor(private readonly identity: {
    readonly domainId: ScoutDomainId;
    readonly name: string;
    readonly fileName: string;
    readonly lockFileName: string;
  }) { super(identity.name); }

  protected location(journalRoot: string) {
    return { journalId: this.identity.domainId, ...recordObjectPaths(journalRoot, this.identity.fileName, this.identity.lockFileName) };
  }

  protected override onWriteFailure(failure: RecordWriteFailure): void {
    currentRunScope().logger.warn({
      module: `domain.${this.identity.domainId}.journal`,
      event: `${this.identity.domainId}_domain_journal_write_failed`,
      message: `Failed to append ${failure.event.key.routeKey} to ${failure.recordId}.`,
      data: {
        journalId: failure.recordId,
        failedEventId: failure.event.id,
        failedEventKey: failure.event.key.routeKey,
        failedAt: failure.failedAt,
        error: failure.error instanceof Error ? failure.error.stack ?? failure.error.message : String(failure.error),
      },
    });
  }
}
