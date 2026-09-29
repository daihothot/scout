/** JSON content owned and interpreted by a benchmark's business producer. */
export type BenchmarkValue = string | number | boolean | null | BenchmarkObject | BenchmarkValue[];

export interface BenchmarkObject {
  [field: string]: BenchmarkValue;
}

/** An explicit reference to an execution identity, never a physical directory or another node. */
export interface BenchmarkWorkflowReference extends BenchmarkObject {
  workflowId: string;
}

/** A node address is only a query/write location inside a chapter, not a reference target. */
export interface BenchmarkNode {
  section: string;
  path: string[];
  value: BenchmarkValue;
}

/** Multiple nodes in one chapter can be committed in one file replacement. */
export interface BenchmarkWrite {
  path: readonly string[];
  value: BenchmarkValue;
}

export interface BenchmarkReferenceNode {
  section: string;
  path: string[];
  reference: BenchmarkWorkflowReference;
}

export interface WorkflowLocation {
  workflowId: string;
  workflowRoot: string;
  journalRoot: string;
}
