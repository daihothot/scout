import type { AgentMessageReply } from "../port.js";

export async function promptForAgentMessage(message: AgentMessageReply): Promise<void> {
  process.stdout.write(`${message.text}\n`);
}
