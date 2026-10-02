/**
 * Tells a listener something without letting it break what told it: a throw
 * is swallowed, and so is the rejection of a listener written `async`. An
 * unobserved rejection is not harmless — under Node's default it ends the
 * process — so a returned thenable always gets a handler.
 */
export function notify<T>(
  listener: ((value: T) => unknown) | undefined,
  value: T,
): void {
  if (listener === undefined) return;
  try {
    const result = listener(value);
    if (isThenable(result)) result.then(undefined, () => {});
  } catch {
    // A listener's mistake is not the stream's.
  }
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
