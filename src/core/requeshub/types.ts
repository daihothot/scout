/** A request contract binds its payload and result without prescribing a consumer. */
export interface RequestType<TPayload extends object, TResult extends object> {
  /** Stable persisted contract name; one host contract owns this name within a service instance. */
  readonly name: string;
  isPayload(value: object): value is TPayload;
  isResult(value: object): value is TResult;
}

/** One independently committed processing result, not the lifetime of its request. */
export interface RequestCompletion<TResult extends object> {
  readonly completionId: string;
  readonly completedAt: string;
  readonly result: TResult;
}

/** Single-consumption requests terminate; multiple-consumption requests retain every result until expired. */
export type RequestSnapshot<TPayload extends object, TResult extends object> = {
  readonly requestId: string;
  readonly type: string;
  readonly payload: TPayload;
  readonly createdAt: string;
} & (
  | ({ readonly consumption: "single" } & (
    | { readonly status: "pending" }
    | ({ readonly status: "completed" } & RequestCompletion<TResult>)
    | { readonly status: "expired"; readonly expiredAt: string; readonly reason: string }
  ))
  | ({ readonly consumption: "multiple"; readonly completions: readonly RequestCompletion<TResult>[] } & (
    | { readonly status: "pending" }
    | { readonly status: "expired"; readonly expiredAt: string; readonly reason: string }
  ))
);

/** Consumption policy is durable; an optional callback belongs only to this live registration. */
export interface RequestRegistrationOptions<TResult extends object> {
  consumption?: "single" | "multiple";
  /** Invoked after each new committed result, never during Journal replay. */
  callback?(result: TResult): void | Promise<void>;
}
