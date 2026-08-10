/** Formats filesystem and parsing failures without hiding the original cause. */
export function describeInspectionError(
  check: string,
  target: string,
  error: unknown,
): string {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return `${check} failed at ${target}${code ? ` [${code}]` : ""}: ${message}`;
}

/** Runs one inspection group and converts unexpected I/O errors into diagnostics. */
export function runInspectionCheck(
  check: string,
  target: string,
  action: () => string | undefined,
): string | undefined {
  try {
    return action();
  } catch (error) {
    return describeInspectionError(check, target, error);
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
