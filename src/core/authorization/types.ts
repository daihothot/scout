/** One application, distinct from the registered authority that can approve it. */
export interface ScoutRequest<TScope extends object = object, TTarget extends object = object, TConsumer extends object = object> {
  readonly workflowId: string;
  readonly consumer: TConsumer;
  readonly scope: TScope;
  readonly target: TTarget;
}
