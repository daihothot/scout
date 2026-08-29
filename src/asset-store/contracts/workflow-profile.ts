import type { CodexModelConfig } from "../../agent-server/codex/model-config.js";
import type { WorkflowPhaseEdges } from "../../core/workflow/index.js";

/** One named resource collection projected into every bound Phase. */
export interface WorkflowResourcePark {
  readonly default?: true;
  readonly phases: readonly string[];
  readonly shellTools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly plugins: readonly string[];
  readonly readableRoots: readonly string[];
  readonly writableRoots: readonly string[];
}

/** One ordered Worker Phase and its outgoing graph edges. */
export interface WorkflowWorkerPhaseDefinition {
  readonly edges: WorkflowPhaseEdges;
}

/** Agent runtime settings owned by one role declaration. */
export interface WorkflowRoleDefinition {
  readonly phases?: readonly string[];
  readonly multiAgent: boolean;
  readonly customAgents: readonly string[];
  readonly model?: CodexModelConfig;
}

/** Repository Workflow Profile selected by Scout Config. */
export interface WorkflowProfile {
  readonly defaults: {
    readonly config: string;
    readonly model: CodexModelConfig;
    readonly maxThreads: number;
    readonly maxDepth: number;
  };
  readonly phases: {
    readonly workers: Readonly<Record<string, WorkflowWorkerPhaseDefinition>>;
  };
  readonly resources: Readonly<Record<string, WorkflowResourcePark>>;
  readonly roles: Readonly<Record<string, WorkflowRoleDefinition>>;
}

/** Selected Workflow Profile plus its repository-relative source identity. */
export interface WorkflowProfileAsset {
  readonly name: string;
  readonly sourcePath: string;
  readonly hash: string;
  readonly profile: WorkflowProfile;
}
