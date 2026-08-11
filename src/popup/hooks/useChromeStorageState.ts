import { useCallback, useEffect, useState } from 'react';

/**
 * React hook that mirrors a `chrome.storage.local` key as component state.
 *
 * - Initial render uses `defaultValue` (storage read is async).
 * - On mount, reads the actual stored value and updates state.
 * - Subscribes to `chrome.storage.local.onChanged` so updates from other
 *   tabs / the background script / the content script flow into the popup
 *   live (e.g. SessionEngine ticking the daily-minutes counter).
 * - Calling the setter writes through to storage AND updates local state
 *   immediately for a snappy UI (no wait for the onChanged round-trip).
 *
 * @param key The chrome.storage.local key.
 * @param defaultValue Value returned before the storage read completes,
 *   and the fallback if the key isn't set.
 */
export function useChromeStorageState<T>(
    key: string,
    defaultValue: T,
): readonly [T, (next: T) => void] {
    const [value, setValue] = useState<T>(defaultValue);

    useEffect(() => {
        let cancelled = false;

        chrome.storage.local.get(key).then((r) => {
            if (cancelled) return;
            if (r[key] !== undefined) setValue(r[key] as T);
        });

        const listener = (
            changes: Record<string, chrome.storage.StorageChange>,
            areaName: string,
        ): void => {
            if (areaName !== 'local' || !changes[key]) return;
            setValue(changes[key].newValue as T);
        };
        chrome.storage.onChanged.addListener(listener);

        return () => {
            cancelled = true;
            chrome.storage.onChanged.removeListener(listener);
        };
    }, [key]);

    const setStored = useCallback(
        (next: T) => {
            setValue(next);
            void chrome.storage.local.set({ [key]: next });
        },
        [key],
    );

    return [value, setStored] as const;
}
