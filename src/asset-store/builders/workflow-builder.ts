import {
  createGraphState,
  SynthesisPhase,
  type GraphState,
} from "../../core/workflow/index.js";
import type { WorkflowProfileAsset } from "../contracts/workflow-profile.js";
import type { AgentProfile } from "../contracts/profile.js";

/** Builds the initial runtime graph from one validated Workflow Profile. */
export class WorkflowBuilder {
  constructor(private readonly asset: WorkflowProfileAsset) {}

  build(): GraphState {
    const workerPhases = Object.entries(this.asset.profile.phases.workers);
    const roles = Object.entries(this.asset.profile.roles).map(([name, role]) => ({
      name,
      phases: name === "coordinator" ? [SynthesisPhase] : role.phases ?? [],
    }));
    return createGraphState({
      workflowProfile: this.asset.name,
      phases: workerPhases.map(([name, phase]) => ({
        name,
        edges: phase.edges,
        roles: roles
          .filter((role) => role.phases.includes(name))
          .map((role) => role.name),
      })),
      roles,
      currentPhase: workerPhases[0]![0],
    });
  }

  /** Builds the effective runtime profile for one Workflow-declared role. */
  buildAgentProfile(roleName: string): AgentProfile {
    const workflow = this.asset.profile;
    const role = workflow.roles[roleName];
    if (!role) {
      throw new Error(`Workflow Profile ${this.asset.name} does not declare role ${roleName}.`);
    }
    const phases = roleName === "coordinator" ? [SynthesisPhase] : [...(role.phases ?? [])];
    const resourceEntries = Object.entries(workflow.resources);
    const defaultResourcePark = resourceEntries
      .find(([, resource]) => resource.default === true)?.[0];
    if (!defaultResourcePark) {
      throw new Error(`Workflow Profile ${this.asset.name} has no default Resource Park.`);
    }
    const selectedResourceParks = new Set<string>();
    for (const phase of phases) {
      const matchingParks = resourceEntries
        .filter(([, resource]) => resource.phases.includes(phase))
        .map(([name]) => name);
      for (const name of matchingParks.length > 0
        ? matchingParks
        : [defaultResourcePark]) {
        selectedResourceParks.add(name);
      }
    }
    const resources = resourceEntries
      .filter(([name]) => selectedResourceParks.has(name));
    const merge = (values: readonly (readonly string[])[]): string[] => [
      ...new Set(values.flatMap((value) => value)),
    ];
    return {
      config: workflow.defaults.config,
      multiAgent: role.multiAgent,
      maxThreads: workflow.defaults.maxThreads,
      maxDepth: workflow.defaults.maxDepth,
      customAgents: [...role.customAgents],
      model: { ...(role.model ?? workflow.defaults.model) },
      phases,
      resourceParks: resources.map(([name]) => name),
      shellTools: merge(resources.map(([, resource]) => resource.shellTools)),
      mcpServers: merge(resources.map(([, resource]) => resource.mcpServers)),
      plugins: merge(resources.map(([, resource]) => resource.plugins)),
      readableRoots: merge(resources.map(([, resource]) => resource.readableRoots)),
      writableRoots: merge(resources.map(([, resource]) => resource.writableRoots)),
    };
  }
}
