import React from "react";
import { type Instance, render } from "ink";
import { ScoutTuiApp } from "./scout-tui-app.js";
import { TuiInteractionAdapter } from "./tui-interaction-adapter.js";
import { TuiStore } from "./tui-store.js";

export interface ScoutTuiRuntime {
  store: TuiStore;
  interactionPort: TuiInteractionAdapter;
  instance: Instance;
  waitUntilExit(): Promise<void>;
}

export function startScoutTui(): ScoutTuiRuntime {
  const store = new TuiStore();
  const interactionPort = new TuiInteractionAdapter(store);
  const instance = render(<ScoutTuiApp store={store} />);
  return {
    store,
    interactionPort,
    instance,
    waitUntilExit: async () => {
      await instance.waitUntilExit();
    },
  };
}
