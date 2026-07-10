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

export interface StartScoutTuiOptions {
  cwd: string;
  version: string;
  model: string;
  reasoningEffort: string;
}

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
