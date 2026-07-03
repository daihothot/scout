import test from "node:test";
import assert from "node:assert/strict";
import {
  context,
  createContextCatalog,
  createContextKeyFactory,
  defineContextCatalog,
} from "../../src/core/context/index.js";
import { composeAttachmentText } from "../../src/agent/context/index.js";
import {
  getWorkerPendingMessageAttachments,
  worker,
} from "../../src/agent/runner/worker/worker-attachments.js";
import { ValidationAgentContexts } from "../../src/domain/validation/agent/context/index.js";

test("context key factory builds domain scope name route keys and rejects duplicates", () => {
  const factory = createContextKeyFactory();
  const key = factory.define({
    domain: "validation",
    scope: "input",
    name: "bdd_fact",
    tag: "latest",
  });

  assert.equal(key.routeKey, "validation.input.bdd_fact.latest");
  assert.equal(factory.build({
    domain: "validation",
    scope: "input",
    name: "bdd_fact",
    tag: "latest",
  }), key.routeKey);
  assert.throws(() => factory.define({
    domain: "validation",
    scope: "input",
    name: "bdd_fact",
    tag: "latest",
  }), /Duplicate context key/);
});

test("context key factory rejects unstable identifier-shaped parts", () => {
  const factory = createContextKeyFactory();

  assert.throws(() => factory.define({
    domain: "domain.validation",
    scope: "input",
    name: "bdd_fact",
  }), /Invalid context key domain/);
  assert.throws(() => factory.define({
    domain: "validation",
    scope: "task-1",
    name: "input",
  }), /Invalid context key scope/);
  assert.throws(() => factory.define({
    domain: "validation",
    scope: "input",
    name: "turn.1",
  }), /Invalid context key name/);
});

test("context catalog infers scope and name from object path", () => {
  const factory = createContextKeyFactory();
  const catalog = defineContextCatalog("validation", {
    input: {
      bddFact: context<string>(),
    },
  }, { factory });

  assert.equal(catalog.input.bddFact.domain, "validation");
  assert.equal(catalog.input.domain, "validation");
  assert.equal(catalog.input.scope, "input");
  assert.equal(catalog.input.routePrefix, "validation.input.");
  assert.equal(catalog.input.bddFact.scope, "input");
  assert.equal(catalog.input.bddFact.name, "bdd_fact");
  assert.equal(catalog.input.bddFact.routeKey, "validation.input.bdd_fact");
  assert.equal(catalog.input.includes(catalog.input.bddFact), true);
});

test("context catalog supports partial add without duplicate properties", () => {
  const factory = createContextKeyFactory();
  const catalog = createContextCatalog("agent", { factory });
  const first = catalog.add({
    turn: {
      input: context<string>(),
    },
  });
  const second = catalog.add({
    thread: {
      instructions: context<string>(),
    },
  });

  assert.equal(first.turn.input.routeKey, "agent.turn.input");
  assert.equal(second.thread.instructions.routeKey, "agent.thread.instructions");
  assert.throws(() => catalog.add({
    turn: {
      input: context<string>(),
    },
  }), /Duplicate context key|Duplicate context catalog property/);
});

test("validation context catalog exposes stable route keys", () => {
  assert.equal(ValidationAgentContexts.input.bddFact.routeKey, "validation.input.bdd_fact");
  assert.equal(ValidationAgentContexts.input.stateSnapshot.routeKey, "validation.input.state_snapshot");
});

test("worker attachment catalog builds turn payloads", () => {
  assert.deepEqual(JSON.parse(worker.turn.task_tick({
    taskId: "task-1",
    status: "running",
    description: "处理任务",
    latestStepId: "step-1",
  })), {
    type: "task_tick",
    task: {
      taskId: "task-1",
      status: "running",
      description: "处理任务",
      latestStepId: "step-1",
    },
    instruction: "continue_current_task",
  });

  const [attachment] = getWorkerPendingMessageAttachments({
    messages: ["继续处理当前 task"],
  });

  assert.equal(composeAttachmentText([attachment]), [
    "<pending-message origin=\"coordinator\">",
    "继续处理当前 task",
    "</pending-message>",
  ].join("\n"));
});
