import { ScoutAgentPhases, ScoutAgentRoles } from "../types.js";
import {
  ScoutAgent,
  type ScoutAgentOptions,
} from "../scout-agent.js";
import type { AgentBackend } from "../backend/agent-backend.js";
import { readRoleAgentInstructions } from "../helper.js";
import { buildDynamicToolsForRole } from "../tool-profiles.js";

export interface CoordinatorAgentOptions extends ScoutAgentOptions {
  agentBackend: AgentBackend;
}

export interface InitialCoordinatorPromptInput {
  runId: string;
  contextBundleId: string;
  scoutInputRef: string;
  mountRoot: string;
}

export class CoordinatorAgent extends ScoutAgent {
  private readonly agentBackend: AgentBackend;

  constructor(options: CoordinatorAgentOptions) {
    super({
      ...options,
      spec: {
        role: ScoutAgentRoles.Coordinator,
        phases: [ScoutAgentPhases.Coordinate],
        cwd: options.agentMount.mountRoot,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        contextBundleId: options.contextBundle.contextBundleId,
        config: {
          model_reasoning_effort: "minimal",
          web_search: "disabled",
          features: {
            shell_tool: false,
            multi_agent: false,
            apps: false,
          },
        },
        developerInstructions: readRoleAgentInstructions(options, ScoutAgentRoles.Coordinator),
        dynamicTools: buildDynamicToolsForRole(ScoutAgentRoles.Coordinator),
      },
    });
    this.agentBackend = options.agentBackend;
    this.agentBackend.registry.registerAgent(this);
  }

  buildInitialPrompt(input: InitialCoordinatorPromptInput): string {
    return [
      "<coordinator-run-start>",
      `  <run-id>${escapeXml(input.runId)}</run-id>`,
      `  <context-bundle-id>${escapeXml(input.contextBundleId)}</context-bundle-id>`,
      `  <scout-input-ref>${escapeXml(input.scoutInputRef)}</scout-input-ref>`,
      `  <mount-root>${escapeXml(input.mountRoot)}</mount-root>`,
      "</coordinator-run-start>",
      "",
      "判断下一步动作。使用 AgentTool 创建或复用 agent 并分配任务；相关任务应优先指定已有 agent_id。使用 SendMessage 推进正在运行或等待输入的任务，使用 TaskStop 停止任务，使用 SyntheticOutput 报告当前或最终综合结论。收到 user-input-request-notification 时，先向用户说明可选项和影响，取得用户回复后再用 SendMessage 把明确选择或补充资料发回对应 agent/task。",
    ].join("\n");
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
