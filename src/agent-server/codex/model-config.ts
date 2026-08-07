/** Provider reasoning effort values accepted by Scout profile validation. */
export type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

/** Provider summary verbosity values persisted in an agent model profile. */
export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none";

/** Normalized model/provider selection passed to Codex thread operations. */
export interface CodexModelConfig {
  id: string;
  provider: string;
  reasoningEffort: CodexReasoningEffort;
  reasoningSummary: CodexReasoningSummary;
}
