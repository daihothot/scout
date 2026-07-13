import type {
  AgentMessageReply,
  RuntimeDisclosureEvent,
  RuntimeInteractionPort,
  RuntimeProgressEvent,
} from "../port.js";
import type { AgentTaskEvent } from "../../agent/task/task-events.js";
import { promptForAgentMessage } from "./prompt.js";
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

  async publishTaskEvent(): Promise<void> {
    // CLI task output is limited to user-facing notifications.
  }

  async notify(event: AgentTaskEvent): Promise<void> {
    process.stdout.write(renderEventNotification(event));
  }

  async publishProgress(event: RuntimeProgressEvent): Promise<void> {
    process.stdout.write(renderProgress(event));
  }

  async receiveAgentMessage(message: AgentMessageReply): Promise<void> {
    await promptForAgentMessage(message);
  }
}
