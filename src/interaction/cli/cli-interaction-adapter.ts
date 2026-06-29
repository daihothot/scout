import type {
  HumanInputRequest,
  HumanInputResponse,
  RuntimeDisclosureEvent,
  RuntimeInteractionPort,
  RuntimeProgressEvent,
} from "../port.js";
import type { RuntimeQueuedCommand } from "../../core/queue/message-queue.js";
import { promptForHumanInput } from "./prompt.js";
import { renderDisclosure, renderProgress, renderQueuedCommandNotification } from "./render.js";

export class CliInteractionAdapter implements RuntimeInteractionPort {
  async disclose(event: RuntimeDisclosureEvent): Promise<void> {
    const rendered = renderDisclosure(event);
    if (event.level === "error" || event.level === "warn") {
      process.stderr.write(rendered);
      return;
    }
    process.stdout.write(rendered);
  }

  async notify(command: RuntimeQueuedCommand): Promise<void> {
    process.stdout.write(renderQueuedCommandNotification(command));
  }

  async publishProgress(event: RuntimeProgressEvent): Promise<void> {
    process.stdout.write(renderProgress(event));
  }

  requestInput(request: HumanInputRequest): Promise<HumanInputResponse> {
    return promptForHumanInput(request);
  }
}
