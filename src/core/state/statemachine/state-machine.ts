/** Work owned by one state. Returning a state requests the next awaited transition. */
export interface MachineState<TState extends string, TPayload> {
  enter(payload: TPayload): TState | void | Promise<TState | void>;
  exit(payload: TPayload): void | Promise<void>;
}

/** Transactions immediately before entry and immediately after exit. */
export interface StateTransition<TPayload> {
  in(payload: TPayload): void | Promise<void>;
  out(payload: TPayload): void | Promise<void>;
}

/** Serializes state entry/exit without interpreting or rolling back domain work. */
export class StateMachine<TState extends string, TPayload> {
  private readonly states = new Map<TState, {
    state: MachineState<TState, TPayload>;
    transition?: StateTransition<TPayload>;
  }>();
  private active?: TState;
  private pending?: Promise<void>;

  register(state: TState, handler: MachineState<TState, TPayload>, transition?: StateTransition<TPayload>): void {
    if (this.pending) throw new Error("Cannot register a state during transition.");
    if (this.states.has(state)) throw new Error(`State is already registered: ${state}`);
    this.states.set(state, { state: handler, transition });
  }

  get currentState(): TState | undefined { return this.active; }
  get transitioning(): boolean { return this.pending !== undefined; }

  /** The current migration's payload is forwarded unchanged, including to returned successors. */
  enterState(target: TState, payload: TPayload): Promise<void> {
    if (this.pending) return Promise.reject(new Error("State machine is transitioning."));
    const pending = Promise.resolve().then(async () => {
      let next: TState | void = target;
      while (next !== undefined) {
        const destination = this.requireState(next);
        if (this.active !== undefined) {
          const previous = this.requireState(this.active);
          await previous.state.exit(payload);
          this.active = undefined;
          await previous.transition?.out(payload);
        }
        await destination.transition?.in(payload);
        const entered = next;
        next = await destination.state.enter(payload);
        this.active = entered;
      }
    }).finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    return pending;
  }

  async drain(): Promise<void> { await this.pending; }

  private requireState(state: TState) {
    const registered = this.states.get(state);
    if (!registered) throw new Error(`State is not registered: ${state}`);
    return registered;
  }
}
