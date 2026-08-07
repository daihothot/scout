import React from "react";
import { type Instance, render } from "ink";
import { ScoutTuiApp } from "./scout-tui-app.js";
import { TuiInteractionAdapter } from "./tui-interaction-adapter.js";
import { TuiStore } from "./tui-store.js";

/** Handles the TUI store, interaction port, and renderer lifetime. */
export interface ScoutTuiRuntime {
  store: TuiStore;
  interactionPort: TuiInteractionAdapter;
  instance: Instance;
  waitUntilExit(): Promise<void>;
}

/** Inputs needed to construct the terminal runtime around a run. */
export interface StartScoutTuiOptions {
  cwd: string;
  version: string;
  model: string;
  reasoningEffort: string;
}

/** Creates the TUI runtime and starts its Ink renderer. */
export function startScoutTui(options: StartScoutTuiOptions): ScoutTuiRuntime {
  const store = new TuiStore(options);
  const interactionPort = new TuiInteractionAdapter(store);
  let exitPromise: Promise<void> | undefined;
  const requestExit = () => {
    if (exitPromise) return;
    exitPromise = (async () => {
      await store.requestExit();
      await instance.waitUntilRenderFlush();
      instance.unmount();
    })();
  };
  const instance = render(<ScoutTuiApp store={store} onExit={requestExit} />, {
    alternateScreen: false,
    exitOnCtrlC: false,
  });
  return {
    store,
    interactionPort,
    instance,
    waitUntilExit: async () => {
      await instance.waitUntilExit();
    },
  };
}
