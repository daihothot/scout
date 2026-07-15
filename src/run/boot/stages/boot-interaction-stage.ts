import type { UnsubscribeEventHandler } from "../../../core/events/index.js";
import {
  InteractionGateway,
  type RuntimeDisclosureEvent,
} from "../../../interaction/index.js";
import type { InteractionExitRequestedPayload } from "../../../interaction/gateway/interaction-events.js";
import { SystemEvents } from "../../../system/events/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { BootStage } from "../boot-stage.js";

export class BootInteractionStage implements BootStage {
  readonly id = "interaction";
  private gateway?: InteractionGateway;
  private unsubscribeExit?: UnsubscribeEventHandler;

  async start(): Promise<void> {
    const scope = currentRunScope();
    const unsubscribeExit = scope.eventBus.subscribe<InteractionExitRequestedPayload>(
      SystemEvents.interaction.exitRequested,
      async (event) => {
        scope.logger.info({
          module: "run.lifecycle",
          event: "run_exit_requested",
          data: {
            requestedAt: event.payload.requestedAt,
          },
        });
        await scope.terminate("exit_requested");
      },
    );
    const gateway = new InteractionGateway({
      eventBus: scope.eventBus,
      interactionPort: scope.interactionPort,
      logger: scope.logger,
    });
    try {
      gateway.start();
    } catch (error) {
      unsubscribeExit();
      throw error;
    }
    this.unsubscribeExit = unsubscribeExit;
    this.gateway = gateway;
    scope.eventBus.publish(SystemEvents.interaction.disclosureRequested, {
      level: "info",
      source: "run.boot",
      message: "Preparing Scout run.",
    } satisfies RuntimeDisclosureEvent);
  }

  async stop(): Promise<void> {
    const gateway = this.gateway;
    const unsubscribeExit = this.unsubscribeExit;
    this.gateway = undefined;
    this.unsubscribeExit = undefined;
    try {
      gateway?.stop();
    } finally {
      unsubscribeExit?.();
    }
  }
}
