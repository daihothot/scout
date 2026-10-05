import { isAbsolute, relative, resolve, sep } from "node:path";
import { currentRunScope } from "../../run/run-scope.js";
import { isPathWithin, resolveWorkflowArtifactPath } from "./path.js";

/** Agent-visible logical address; each symbol is one literal segment beneath the owner's Artifact root. */
export interface ScoutArtifactReference {
  readonly workflowId: string;
  readonly agentId: string;
  readonly internalSymbols: readonly string[];
}

/** Decodes external tool or persisted input; trusted constructed references need no repeated validation. */
export function readArtifactReference(value: unknown): ScoutArtifactReference {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("workflowId" in value) || typeof value.workflowId !== "string" || !/^workflow-[0-9]{3,}$/.test(value.workflowId)
    || !("agentId" in value) || typeof value.agentId !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.agentId)
    || value.agentId === "." || value.agentId === ".."
    || !("internalSymbols" in value) || !Array.isArray(value.internalSymbols)
    || value.internalSymbols.some((part: unknown) => typeof part !== "string" || !part
      || part === "." || part === ".." || /[\/\\\u0000-\u001f\u007f]/.test(part))) {
    throw new Error("Invalid ScoutArtifactReference.");
  }
  return { workflowId: value.workflowId, agentId: value.agentId, internalSymbols: [...value.internalSymbols] };
}

/** Internal source-key / record encoding, never an Agent-facing path contract. */
export function formatArtifactReference(reference: ScoutArtifactReference): string {
  return `scout-artifact://${reference.workflowId}/${reference.agentId}/${reference.internalSymbols.join("/")}`;
}

/** Decodes internal URI storage; segments remain literal, never URL-decoded. */
export function parseArtifactReference(reference: string): ScoutArtifactReference {
  const match = /^scout-artifact:\/\/([^/]+)\/([^/]+)\/(.*)$/.exec(reference);
  if (!match) throw new Error("Invalid scout-artifact reference.");
  try {
    return readArtifactReference({ workflowId: match[1], agentId: match[2],
      internalSymbols: match[3] === "" ? [] : match[3]!.split("/") });
  } catch { throw new Error("Invalid scout-artifact reference."); }
}

/** Stable range containment, independent of directory names and filesystem availability. */
export function isArtifactTargetWithin(root: ScoutArtifactReference, target: ScoutArtifactReference): boolean {
  return root.workflowId === target.workflowId && root.agentId === target.agentId
    && root.internalSymbols.length <= target.internalSymbols.length
    && root.internalSymbols.every((symbol, index) => symbol === target.internalSymbols[index]);
}

/** Converts logical identity to the current physical location; it does not grant access. */
export function resolveArtifactTarget(target: ScoutArtifactReference): { path: string } | { reason: string } {
  return resolveWorkflowArtifactPath(currentRunScope().runRoot, target.workflowId, target.agentId, target.internalSymbols.join("/"));
}

/** Matches one native literal read beneath a logical registered range, without widening it. */
export function resolveArtifactReadTarget(
  root: ScoutArtifactReference, requestedPath: string,
): { target: ScoutArtifactReference; path: string } | { reason: string } {
  const resolved = resolveArtifactTarget(root);
  if ("reason" in resolved) return resolved;
  if (!isAbsolute(requestedPath) || !isPathWithin(resolved.path, requestedPath)) {
    return { reason: "Read target is outside the registered Artifact range." };
  }
  const suffix = relative(resolved.path, requestedPath);
  const target = { ...root, internalSymbols: [...root.internalSymbols, ...(suffix ? suffix.split(sep) : [])] };
  const location = resolveArtifactTarget(target);
  return "reason" in location ? location : { target, path: location.path };
}

/** Replaces the current Agent's physical artifact path with a stable Workflow identity reference. */
export function canonicalizeAgentArtifactReferences(
  value: string,
  input: { workflowId: string; agentId: string; artifactRoot: string },
): string {
  const root = resolve(input.artifactRoot);
  return value.replaceAll(`${root}${sep}`, `scout-artifact://${input.workflowId}/${input.agentId}/`);
}

/** Supplies physical paths for known artifact roots; it neither registers nor grants access. */
export function resolveAgentArtifactReferences(
  value: string,
  input: {
    workflowId: string;
    artifacts: readonly { agentId: string; path: string }[];
    readRequests: readonly { artifact_ref: string; read_path: string }[];
  },
): { ref: string; path: string }[] {
  const resolved = new Map<string, string>();
  // Quoted references may contain spaces; bare references end at text/Markdown delimiters.
  const references = /(["'`])(scout-artifact:\/\/[^"'`\r\n]+)\1|(scout-artifact:\/\/[^\s"'`<>()\[\]{},;*]+)/g;
  const roots = [
    ...input.artifacts.map((artifact) => ({ prefix: `scout-artifact://${input.workflowId}/${artifact.agentId}/`, path: artifact.path })),
    ...input.readRequests.map((request) => ({ prefix: `${request.artifact_ref}/`, path: request.read_path })),
  ];
  for (const match of value.matchAll(references)) {
    const ref = match[2] ?? match[3]!;
    if (resolved.has(ref)) continue;
    const root = roots.find(({ prefix }) => ref.startsWith(prefix));
    if (!root) continue;
    const relativePath = ref.slice(root.prefix.length);
    if (!relativePath || isAbsolute(relativePath) || /[\u0000-\u001f\u007f\\]/.test(relativePath)) continue;
    const path = resolve(root.path, relativePath);
    if (!isPathWithin(root.path, path, { allowRoot: false })) continue;
    resolved.set(ref, path);
  }
  return [...resolved].map(([ref, path]) => ({ ref, path }));
}
