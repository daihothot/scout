import { testWorkflowParticipant } from "../helpers/workflow-participant.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  DomainRegistry,
  DomainAgentBackend,
  ScoutDomainId,
  type ScoutDomain,
} from "../../src/domain/index.js";

test("DomainRegistry retains every Scout Domain in registration order", () => {
  const registry = new DomainRegistry();
  const base = domain(ScoutDomainId.Base, "Base");
  const rbt = domain(ScoutDomainId.Rbt, "RBT");

  registry.register(base);
  registry.register(rbt);

  assert.equal(registry.get(ScoutDomainId.Base), base);
  assert.equal(registry.get(ScoutDomainId.Rbt), rbt);
  assert.deepEqual(registry.list(), [base, rbt]);
  assert.equal(rbt.description.id, ScoutDomainId.Rbt);
});

test("DomainRegistry rejects duplicate ids and an inactive unregister", () => {
  const registry = new DomainRegistry();
  const registered = domain(ScoutDomainId.Rbt, "RBT");
  const duplicate = domain(ScoutDomainId.Rbt, "Duplicate RBT");
  registry.register(registered);

  assert.throws(
    () => registry.register(duplicate),
    /Scout Domain rbt is already registered/,
  );
  assert.throws(
    () => registry.unregister(duplicate),
    /Cannot unregister inactive Scout Domain rbt/,
  );

  registry.unregister(registered);
  assert.deepEqual(registry.list(), []);
  assert.throws(
    () => registry.get(ScoutDomainId.Rbt),
    /Scout Domain rbt is not registered/,
  );
});

function domain(id: ScoutDomainId, name: string): ScoutDomain {
  return {
    ...testWorkflowParticipant,
    description: { id, name },
    backend: new class extends DomainAgentBackend {
      override async handleDynamicToolCall() { return undefined; }
    }(),
  };
}
