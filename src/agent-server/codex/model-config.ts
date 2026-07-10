export type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none";

export interface CodexModelConfig {
  id: string;
  provider: string;
  reasoningEffort: CodexReasoningEffort;
  reasoningSummary: CodexReasoningSummary;
}
