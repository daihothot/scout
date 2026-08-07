/** Discriminated success/error value used to return without throwing. */
export type Result<T, E> =
  | {
    readonly ok: true;
    readonly value: T;
  }
  | {
    readonly ok: false;
    readonly error: E;
  };

/** Constructors for the two branches of {@link Result}. */
export const Result = {
  ok<T>(value: T): Result<T, never> {
    return {
      ok: true,
      value,
    };
  },

  err<E>(error: E): Result<never, E> {
    return {
      ok: false,
      error,
    };
  },
} as const;
