import React from "react";
import { type Instance, render } from "ink";
import { ScoutTuiApp } from "./scout-tui-app.js";
import { TuiInteractionAdapter } from "./tui-interaction-adapter.js";
import { TuiStore } from "./tui-store.js";

type ResizeListener = (...args: unknown[]) => void;

interface TuiResizeStdout {
  stdout: NodeJS.WriteStream;
  dispose: () => void;
}

/**
 * Lets React's useWindowSize own resize renders. Ink's native resize callback
 * renders synchronously before that hook receives the new dimensions, which
 * produces one stale frame when a terminal is narrowed.
 */
export function createTuiResizeStdout(stdout: NodeJS.WriteStream): TuiResizeStdout {
  if (!stdout.isTTY) {
    return { stdout, dispose: () => {} };
  }
  const listeners = new Set<ResizeListener>();
  let inkResizeListenerSkipped = false;
  let disposed = false;
  const dispatchResize = (...args: unknown[]) => {
    if (disposed) return;
    for (const listener of [...listeners]) listener(...args);
  };
  stdout.on("resize", dispatchResize);

  const proxy = new Proxy(stdout, {
    get(target, property, receiver) {
      if (property === "on") {
        return (event: string, listener: ResizeListener) => {
          if (event === "resize") {
            if (!inkResizeListenerSkipped) {
              // Ink registers its eager handler before React mounts
              // useWindowSize. That handler is intentionally not retained.
              inkResizeListenerSkipped = true;
              return proxy;
            }
            listeners.add(listener);
            return proxy;
          }
          const on = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
          return on.call(target, event, listener);
        };
      }
      if (property === "off" || property === "removeListener") {
        return (event: string, listener: ResizeListener) => {
          if (event === "resize") {
            listeners.delete(listener);
            return proxy;
          }
          const off = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
          return off.call(target, event, listener);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as NodeJS.WriteStream;

  return {
    stdout: proxy,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      stdout.off("resize", dispatchResize);
    },
  };
}

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
  const resizeStdout = createTuiResizeStdout(process.stdout);
  let exitPromise: Promise<void> | undefined;
  const requestExit = () => {
    if (exitPromise) return;
    exitPromise = (async () => {
      await store.requestExit();
      await instance.waitUntilRenderFlush();
      instance.unmount();
    })();
  };
  let instance: Instance;
  try {
    instance = render(<ScoutTuiApp store={store} onExit={requestExit} />, {
      alternateScreen: false,
      exitOnCtrlC: false,
      // Task/activity updates must not erase the prompt while a native IME
      // composition is anchored to its terminal cursor.
      incrementalRendering: true,
      stdout: resizeStdout.stdout,
    });
  } catch (error) {
    resizeStdout.dispose();
    throw error;
  }
  return {
    store,
    interactionPort,
    instance,
    waitUntilExit: async () => {
      try {
        await instance.waitUntilExit();
      } finally {
        resizeStdout.dispose();
      }
    },
  };
}
