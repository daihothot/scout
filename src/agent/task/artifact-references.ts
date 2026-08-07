import { relative, resolve, sep } from "node:path";
import { isPathWithin } from "../../core/path.js";

const LOCAL_ARTIFACT_ROOT = "${SCOUT_ARTIFACT_ROOT}";
const RUN_ROOT = "${SCOUT_RUN_ROOT}";

/** Rewrites local artifact macros into the portable run-root representation. */
export function canonicalizeAgentArtifactReferences(
  value: string,
  input: {
    runRoot: string;
    artifactRoot: string;
  },
): string {
  if (!value.includes(LOCAL_ARTIFACT_ROOT)) return value;

  const artifactRootRef = relative(resolve(input.runRoot), resolve(input.artifactRoot));
  if (!isPathWithin(input.runRoot, input.artifactRoot, { allowRoot: false })) {
    throw new Error(
      `Agent artifact root must be a child of the run root: ${input.artifactRoot}`,
    );
  }

  const portableRoot = `${RUN_ROOT}/${artifactRootRef.split(sep).join("/")}`;
  return value.replaceAll(LOCAL_ARTIFACT_ROOT, portableRoot);
}
