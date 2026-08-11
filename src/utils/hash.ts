/**
 * DJB2 Hash Utility
 *
 * Fast, deterministic string hash for cache key generation.
 * Used by both the text analyzer (L1 cache) and the persistent
 * result cache (L2) to avoid raw-string key collisions.
 *
 * No crypto needed — this is cache deduplication, not security.
 */

export function djb2Hash(input: string): string {
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) + hash + input.charCodeAt(i)) & 0xffffffff;
    }
    return (hash >>> 0).toString(36);
}
