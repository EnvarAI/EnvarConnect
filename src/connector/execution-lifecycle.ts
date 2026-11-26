/** Shared local barriers; protocol records and their receipts remain protocol-owned. */
export class ExecutionLifecycle {
  constructor(
    private readonly lease: () => Promise<void>,
    private readonly interval: number,
    private readonly leaseFailed: (error: unknown) => void = () => {},
  ) {}

  async observe<T>(operation: () => Promise<T>): Promise<T> {
    let active: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (!active)
        active = this.lease()
          .catch(this.leaseFailed)
          .finally(() => {
            active = undefined;
          });
    }, this.interval);
    try {
      return await operation();
    } finally {
      clearInterval(timer);
      await active;
    }
  }

  /** Commit the existing journal marker before exposing the one native dispatch. */
  prepareDispatch<T>(persistIntent: () => void, operation: () => Promise<T>): () => Promise<T> {
    persistIntent();
    let invoked = false;
    return () => {
      if (invoked)
        throw new Error(
          'This native dispatch was already attempted. Recover the original execution.',
        );
      invoked = true;
      return this.observe(operation);
    };
  }
}
