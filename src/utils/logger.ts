/**
 * Debug-Gated Logger
 *
 * Replaces raw console.log/warn calls in production code.
 * - debug/warn: Only output in dev mode (Vite's import.meta.env.DEV)
 * - error: Always output (errors should never be swallowed)
 */

// Vite statically replaces `import.meta.env.DEV` with `true` (dev) or `false` (prod)
// at build time. This means the reference never exists at runtime — it's a literal boolean.
// The `vite-env.d.ts` type declaration makes TypeScript accept this pattern.
const IS_DEV = import.meta.env.DEV;

export const logger = {
    debug: (...args: unknown[]): void => {
        if (IS_DEV) console.log('[Lucid]', ...args);
    },
    warn: (...args: unknown[]): void => {
        if (IS_DEV) console.warn('[Lucid]', ...args);
    },
    error: (...args: unknown[]): void => {
        console.error('[Lucid]', ...args);
    },
};
