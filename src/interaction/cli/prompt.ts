import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { HumanInputRequest, HumanInputResponse } from "../port.js";

export async function promptForHumanInput(request: HumanInputRequest): Promise<HumanInputResponse> {
  const rl = readline.createInterface({ input, output });
  try {
    const suffix = request.defaultValue ? ` [${request.defaultValue}]` : "";
    const answer = await rl.question(`${request.prompt}${suffix}\n> `);
    return {
      requestId: request.id,
      text: answer.trim().length > 0 ? answer : request.defaultValue ?? "",
    };
  } finally {
    rl.close();
  }
}
