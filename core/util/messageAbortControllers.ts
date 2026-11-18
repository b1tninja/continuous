/**
 * The abort controllers of in-flight requests from the webview, by message
 * id, so that an "abort" message can find the request it names.
 *
 * An entry used to be removed only when its request was aborted. A request
 * that finished normally, which is nearly all of them, left its entry for
 * the life of the extension host.
 */
export class MessageAbortControllers {
  private readonly controllers = new Map<string, AbortController>();

  get size(): number {
    return this.controllers.size;
  }

  add(id: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    controller.signal.addEventListener("abort", () =>
      this.release(id, controller),
    );
    return controller;
  }

  abort(id: string): void {
    this.controllers.get(id)?.abort();
  }

  /** Forgets a finished request, unless its id has been reused since. */
  release(id: string, controller: AbortController): void {
    if (this.controllers.get(id) === controller) {
      this.controllers.delete(id);
    }
  }

  /**
   * Passes a stream through unchanged (values, return value, errors, and
   * early return) and releases its controller when the stream ends.
   */
  async *releaseWhenDone<T, TReturn>(
    id: string,
    controller: AbortController,
    stream: AsyncGenerator<T, TReturn>,
  ): AsyncGenerator<T, TReturn> {
    try {
      return yield* stream;
    } finally {
      this.release(id, controller);
    }
  }
}
