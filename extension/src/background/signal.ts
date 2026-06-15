// Leak-free AbortSignal composition.
// AbortSignal.timeout(ms) creates a timer that can't be cancelled when the
// request completes early — leaks across hundreds of agent turns.
// Manual setTimeout + clearTimeout with mandatory cleanup() in finally.

export interface SignalBundle {
  signal: AbortSignal;
  cleanup(): void;
}

export function composeSignal(timeoutMs: number, userSignal?: AbortSignal): SignalBundle {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let userOnAbort: (() => void) | null = null;
  let aborted = false;

  const abort = (reason: unknown) => {
    if (aborted) return;
    aborted = true;
    try {
      ctrl.abort(reason);
    } catch {
      /* noop */
    }
  };

  if (userSignal) {
    if (userSignal.aborted) {
      abort(userSignal.reason);
    } else {
      userOnAbort = () => abort(userSignal.reason ?? new DOMException('User aborted', 'AbortError'));
      userSignal.addEventListener('abort', userOnAbort, { once: true });
    }
  }

  if (timeoutMs > 0 && !aborted) {
    timer = setTimeout(
      () => abort(new DOMException(`Timed out after ${timeoutMs}ms`, 'TimeoutError')),
      timeoutMs,
    );
  }

  const cleanup = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (userSignal && userOnAbort) {
      try {
        userSignal.removeEventListener('abort', userOnAbort);
      } catch {
        /* noop */
      }
      userOnAbort = null;
    }
  };

  return { signal: ctrl.signal, cleanup };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
