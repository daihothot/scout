import type {
  HumanInputRequest,
  HumanInputResponse,
  RuntimeDisclosureEvent,
  RuntimeInteractionPort,
  RuntimeProgressEvent,
} from "../port.js";
import type { AgentTaskSystemEvent } from "../../agent/task/task-events.js";
import { promptForHumanInput } from "./prompt.js";
import { renderDisclosure, renderEventNotification, renderProgress } from "./render.js";

export class CliInteractionAdapter implements RuntimeInteractionPort {
  async disclose(event: RuntimeDisclosureEvent): Promise<void> {
    const rendered = renderDisclosure(event);
    if (event.level === "error" || event.level === "warn") {
      process.stderr.write(rendered);
      return;
    }
    process.stdout.write(rendered);
  }

  async notify(event: AgentTaskSystemEvent): Promise<void> {
    process.stdout.write(renderEventNotification(event));
  }

  async publishProgress(event: RuntimeProgressEvent): Promise<void> {
    process.stdout.write(renderProgress(event));
  }

  requestInput(request: HumanInputRequest): Promise<HumanInputResponse> {
    return promptForHumanInput(request);
  }
}
