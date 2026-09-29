/** A request contract binds its payload and result without prescribing a consumer. */
export interface RequestType<TPayload extends object, TResult extends object> {
  readonly name: string;
  isPayload(value: object): value is TPayload;
  isResult(value: object): value is TResult;
}

/** Detached request data; a completed record always has a result. */
export type RequestSnapshot<TPayload extends object, TResult extends object> = {
  readonly requestId: string;
  readonly type: string;
  readonly payload: TPayload;
  readonly createdAt: string;
} & (
  | { readonly status: "pending" }
  | { readonly status: "completed"; readonly completedAt: string; readonly result: TResult }
  | { readonly status: "expired"; readonly expiredAt: string; readonly reason: string }
);

/** Optional business callback, invoked once after completion is committed. */
export interface RequestRegistrationOptions<TResult extends object> {
  callback?(result: TResult): void | Promise<void>;
}
