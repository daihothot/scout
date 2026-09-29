import { currentRunScope } from "../../../../run/run-scope.js";
import type { BenchmarkWrite } from "../../../../core/workflow/benchmarks/index.js";
import type { ScoutDomainId } from "../../../types.js";

/** Domain chapter ownership and a single submission path; business fields belong to subclasses. */
export abstract class DomainBenchmarks {
  protected constructor(readonly domainId: ScoutDomainId) {}

  protected submit(writes: readonly BenchmarkWrite[]): void {
    currentRunScope().workflow.benchmarks.submit(this.domainId, writes);
  }
}
