import { isAbsolute, resolve, sep } from "node:path";
import { isPathWithin } from "../../core/path.js";

/** Replaces the current Agent's physical artifact path with a stable Workflow identity reference. */
export function canonicalizeAgentArtifactReferences(
  value: string,
  input: {
    workflowId: string;
    agentId: string;
    artifactRoot: string;
  },
): string {
  const root = resolve(input.artifactRoot);
  return value.replaceAll(`${root}${sep}`, `scout-artifact://${input.workflowId}/${input.agentId}/`);
}

/** Supplies current-Workflow access paths without rewriting the referenced content or granting access. */
export function resolveAgentArtifactReferences(
  value: string,
  input: {
    workflowId: string;
    artifacts: readonly { agentId: string; path: string }[];
  },
): { ref: string; path: string }[] {
  const resolved = new Map<string, string>();
  // Quoted references may contain spaces; bare references end at text/Markdown delimiters.
  const references = /(["'`])(scout-artifact:\/\/[^"'`\r\n]+)\1|(scout-artifact:\/\/[^\s"'`<>()\[\]{},;*]+)/g;
  const prefix = `scout-artifact://${input.workflowId}/`;
  for (const match of value.matchAll(references)) {
    const ref = match[2] ?? match[3]!;
    if (!ref.startsWith(prefix) || resolved.has(ref)) continue;
    const location = ref.slice(prefix.length);
    const separator = location.indexOf("/");
    if (separator < 0) continue;
    const artifact = input.artifacts.find(({ agentId }) => agentId === location.slice(0, separator));
    if (!artifact) continue;
    const relativePath = location.slice(separator + 1);
    if (!relativePath || isAbsolute(relativePath) || /[\u0000-\u001f\u007f\\]/.test(relativePath)) continue;
    const path = resolve(artifact.path, relativePath);
    if (!isPathWithin(artifact.path, path, { allowRoot: false })) continue;
    resolved.set(ref, path);
  }
  return [...resolved].map(([ref, path]) => ({ ref, path }));
}
