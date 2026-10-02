import { join, resolve } from "node:path";
import { SynthesisPhase } from "../../core/workflow/graph-data.js";
import { sha256File } from "../../core/fs.js";
import { parseWorkflowProfile, workflowProfilePath } from "../assets/workflow-profiles.js";
import { ScoutAssetLayout } from "../assets/asset-layout.js";
import { AssetJsonReader } from "../files/asset-json-reader.js";
import type { WorkflowProfileAsset } from "../contracts/workflow-profile.js";
import type { AgentProfile } from "../contracts/profile.js";

/** Builds a validated, identified Asset without creating runtime state. */
export function buildWorkflow(scoutRoot: string, name: string): WorkflowProfileAsset {
  const path = workflowProfilePath(scoutRoot, name);
  const workflowRoot = join(resolve(scoutRoot), "assets", "scout", ScoutAssetLayout.workflowsRoot);
  return {
    name,
    sourcePath: `${ScoutAssetLayout.workflowsRoot}/${name}.json`,
    hash: sha256File(path),
    profile: parseWorkflowProfile(new AssetJsonReader(workflowRoot).readJson(`${name}.json`), path),
  };
}

/** Builds role profiles from one validated Workflow Asset. */
export class WorkflowBuilder {
  constructor(private readonly asset: WorkflowProfileAsset) {}

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
      .find(([, resource]) => resource.default === true);
    const selectedResourceParks = new Set<string>();
    for (const phase of phases) {
      const matchingParks = resourceEntries.filter(([, resource]) =>
        resource.default !== true && resource.phases.includes(phase)
      );
      const inheritedDefaultParks = defaultResourcePark
        && (
          defaultResourcePark[1].phases.length === 0
          || defaultResourcePark[1].phases.includes(phase)
        )
        ? [defaultResourcePark]
        : [];
      const phaseResourceParks = [...inheritedDefaultParks, ...matchingParks];
      if (phaseResourceParks.length === 0) {
        throw new Error(
          `Workflow Profile ${this.asset.name} role ${roleName}`
          + ` has no Resource Park for Phase ${phase}.`,
        );
      }
      for (const [name] of phaseResourceParks) {
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
      network: resources.some(([, resource]) => resource.network === true),
    };
  }
}
