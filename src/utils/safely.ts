/**
 * Non-blocking fire-and-forget wrapper with debug logging.
 * Replaces 120+ silent catch(() => {}) patterns across the codebase.
 * Never throws — always returns void.
 */
export function safely(fn: () => void, label?: string): void {
  try {
    fn();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[safely:${label || 'unnamed'}] ${msg}`);
  }
}

/** Async variant — accepts a promise or promise factory, never rejects */
export async function safelyAsync(fnOrPromise: (() => Promise<unknown>) | Promise<unknown>, label?: string): Promise<void> {
  try {
    if (typeof fnOrPromise === 'function') {
      await fnOrPromise();
    } else {
      await fnOrPromise;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[safelyAsync:${label || 'unnamed'}] ${msg}`);
  }
}
