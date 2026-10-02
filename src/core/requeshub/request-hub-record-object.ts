import type { ScoutEvent } from "../events/index.js";
import { requestHubJournalPaths } from "../path.js";
import { RecordableObject, type RecordEvent } from "../record/index.js";
import { currentRunScope } from "../../run/run-scope.js";

/** Request facts are durable before publication; callbacks and approval rules stay outside. */
export class RequestHubRecordObject extends RecordableObject {
  // Explicit recording gates request consumption. Broadcast must not append twice.
  readonly eventTypes = [];
  private facts: ScoutEvent[] = [];

  constructor() { super("RequestHub"); }

  override start(): void {
    super.start();
    if (this.hasActiveRecord) this.facts = super.readAll();
  }

  protected location(journalRoot: string) {
    return { journalId: `${currentRunScope().runId}:request-hub`, ...requestHubJournalPaths(journalRoot) };
  }

  protected override baselineEvents(): readonly ScoutEvent[] { return this.facts; }

  protected decode(records: readonly RecordEvent[]): RecordEvent[] { return [...records]; }

  readFacts(): readonly ScoutEvent[] {
    if (this.hasActiveRecord) this.facts = this.read();
    return structuredClone(this.facts);
  }

  record(event: ScoutEvent): void {
    const { scope, group, name, tag, routeKey } = event.key;
    const fact: ScoutEvent = {
      id: event.id, occurredAt: event.occurredAt,
      key: { scope, group, name, ...(tag ? { tag } : {}), routeKey },
      payload: structuredClone(event.payload),
    };
    if (this.hasActiveRecord) this.write(fact);
    // Empty Workflow requests are process-local. Their facts can seed the next
    // Workflow, without creating a Run-owned recording file or expiring requests.
    this.facts.push(fact);
  }
}
