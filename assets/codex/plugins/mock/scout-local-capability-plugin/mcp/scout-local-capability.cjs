#!/usr/bin/env node
const readline = require("node:readline");

const marker = "SCOUT_LOCAL_CAPABILITY_OK";
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined || request.id === null) return;

  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "scout_local_capability", version: "0.1.0" },
        instructions: "Local Scout capability fixture."
      }
    });
    return;
  }

  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "scout_capability_echo",
            description: "Return the Scout local capability marker.",
            inputSchema: {
              type: "object",
              properties: {
                message: { type: "string" }
              }
            }
          }
        ]
      }
    });
    return;
  }

  if (request.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [
          {
            type: "text",
            text: marker + "::" + (request.params && request.params.arguments ? request.params.arguments.message : "")
          }
        ],
        isError: false
      }
    });
    return;
  }

  if (request.method === "resources/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { resources: [] } });
    return;
  }

  if (request.method === "resources/templates/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { resourceTemplates: [] } });
    return;
  }

  send({ jsonrpc: "2.0", id: request.id, result: {} });
});
