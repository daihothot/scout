import { isAbsolute, relative, resolve, sep } from "node:path";

export interface PathWithinOptions {
  allowRoot?: boolean;
}

/**
 * Tests lexical containment after normalizing both paths, without resolving symlinks.
 * Filesystem callers must perform their own realpath/lstat checks when that matters.
 */
export function isPathWithin(
  root: string,
  target: string,
  options: PathWithinOptions = {},
): boolean {
  const pathFromRoot = relative(resolve(root), resolve(target));
  if (pathFromRoot === "") return options.allowRoot !== false;
  return !isAbsolute(pathFromRoot)
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`);
}
