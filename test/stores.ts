/**
 * Reference stores: one correct, and a family of deliberately broken ones.
 *
 * Not a test file, so the runner's glob skips it.
 *
 * The broken stores are the important half. A conformance suite that only
 * ever runs against a correct implementation proves nothing — every check
 * would pass if `run` returned null unconditionally. Each store here violates
 * exactly one property, so the suite can be held to the standard it asks of
 * others: every check must be demonstrably capable of failing.
 */

import type { ClaimStore, Credential } from "../src/types.ts";

interface Row {
    id: string;
    expiresAt: number | undefined;
    maxAttempts: number | undefined;
    attempts: number;
    claimedAt: number | null;
}

/** Yields to the event loop, so concurrent callers actually interleave. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function table() {
    return new Map<string, Row>();
}

function insert(rows: Map<string, Row>, credential: Credential): void {
    rows.set(credential.id, {
        id: credential.id,
        expiresAt: credential.expiresAt,
        maxAttempts: credential.maxAttempts,
        attempts: 0,
        claimedAt: null,
    });
}

/** True when the row is live at `now`. */
function live(row: Row, now: number): boolean {
    if (row.claimedAt !== null) return false;
    if (row.expiresAt !== undefined && row.expiresAt <= now) return false;
    if (row.maxAttempts !== undefined && row.attempts >= row.maxAttempts) return false;
    return true;
}

/**
 * The correct implementation.
 *
 * The claim is synchronous from the guard through the write — no `await`
 * between deciding and setting `claimedAt` — which is what a single guarded
 * `UPDATE` gives you in SQL. The `await` before it is deliberate: it proves
 * the suite's concurrency is real, since callers genuinely interleave at that
 * point and still elect one winner.
 */
export function correctStore(): ClaimStore<Row> {
    const rows = table();
    return {
        async issue(credential) {
            insert(rows, credential);
        },
        async claim({ id, now }) {
            await tick();
            const row = rows.get(id);
            // Compare and swap, with nothing suspending in between.
            if (!row || !live(row, now)) return null;
            row.claimedAt = now;
            return row;
        },
        async spendAttempt({ id, now }) {
            await tick();
            const row = rows.get(id);
            if (row && live(row, now)) row.attempts += 1;
        },
    };
}

/**
 * The mistake this package exists to catch: read, decide, then write, with a
 * suspension point in the middle.
 */
export function readThenWriteStore(): ClaimStore<Row> {
    const rows = table();
    return {
        async issue(credential) {
            insert(rows, credential);
        },
        async claim({ id, now }) {
            const row = rows.get(id);
            if (!row || !live(row, now)) return null;
            await tick(); // ← the window
            row.claimedAt = now;
            return row;
        },
    };
}

/** Never marks anything claimed: single use is not enforced at all. */
export function neverMarksStore(): ClaimStore<Row> {
    const rows = table();
    return {
        async issue(credential) {
            insert(rows, credential);
        },
        async claim({ id, now }) {
            const row = rows.get(id);
            return row && live(row, now) ? row : null;
        },
    };
}

/** Ignores expiry in the guard. */
export function ignoresExpiryStore(): ClaimStore<Row> {
    const rows = table();
    return {
        async issue(credential) {
            insert(rows, credential);
        },
        async claim({ id }) {
            await tick();
            const row = rows.get(id);
            if (!row || row.claimedAt !== null) return null;
            row.claimedAt = 1;
            return row;
        },
    };
}

/** Ignores the attempt budget in the guard. */
export function ignoresBudgetStore(): ClaimStore<Row> {
    const rows = table();
    return {
        async issue(credential) {
            insert(rows, credential);
        },
        async claim({ id, now }) {
            await tick();
            const row = rows.get(id);
            if (!row || row.claimedAt !== null) return null;
            if (row.expiresAt !== undefined && row.expiresAt <= now) return null;
            row.claimedAt = now;
            return row;
        },
        async spendAttempt({ id }) {
            const row = rows.get(id);
            if (row) row.attempts += 1;
        },
    };
}

/** Loses concurrent decrements: read-then-write on the counter. */
export function losesAttemptsStore(): ClaimStore<Row> {
    const rows = table();
    return {
        async issue(credential) {
            insert(rows, credential);
        },
        async claim({ id, now }) {
            await tick();
            const row = rows.get(id);
            if (!row || !live(row, now)) return null;
            row.claimedAt = now;
            return row;
        },
        async spendAttempt({ id }) {
            const row = rows.get(id);
            if (!row) return;
            const observed = row.attempts;
            await tick(); // ← the window
            row.attempts = observed + 1;
        },
    };
}

/** Claims anything, including ids that were never issued. */
export function failsOpenStore(): ClaimStore<Row> {
    const rows = table();
    return {
        async issue(credential) {
            insert(rows, credential);
        },
        async claim({ id, now }) {
            const row = rows.get(id);
            if (row && live(row, now)) {
                row.claimedAt = now;
                return row;
            }
            return { id, expiresAt: undefined, maxAttempts: undefined, attempts: 0, claimedAt: now };
        },
    };
}

/** Correct, but serializes every claim behind one global lock. */
export function globallyLockedStore(): ClaimStore<Row> {
    const rows = table();
    let held = false;
    return {
        async issue(credential) {
            insert(rows, credential);
        },
        async claim({ id, now }) {
            // A real system would queue here. Refusing instead makes the
            // over-broad lock observable in a single pass.
            if (held) return null;
            held = true;
            try {
                await tick();
                const row = rows.get(id);
                if (!row || !live(row, now)) return null;
                row.claimedAt = now;
                return row;
            } finally {
                held = false;
            }
        },
    };
}

/** Claiming one credential wipes every other: an over-broad guard. */
export function overBroadGuardStore(): ClaimStore<Row> {
    const rows = table();
    return {
        async issue(credential) {
            insert(rows, credential);
        },
        async claim({ id, now }) {
            await tick();
            const row = rows.get(id);
            if (!row || !live(row, now)) return null;
            for (const other of rows.values()) other.claimedAt = now;
            return row;
        },
    };
}

/**
 * Correct, but without an attempt budget — the common shape for OAuth codes
 * and idempotency keys, where there is nothing to guess.
 */
export function correctStoreWithoutAttempts(): ClaimStore<Row> {
    const rows = table();
    return {
        async issue(credential) {
            insert(rows, credential);
        },
        async claim({ id, now }) {
            await tick();
            const row = rows.get(id);
            if (!row || !live(row, now)) return null;
            row.claimedAt = now;
            return row;
        },
    };
}

/**
 * Refuses every claim.
 *
 * Broken in the *restrictive* direction, which the permissive stores above
 * cannot exercise. Without it the suite's positive checks — the ones
 * asserting a live credential is claimable at all — would never be shown to
 * fail, and a suite whose checks cannot fail is decoration.
 */
export function alwaysNullStore(): ClaimStore<Row> {
    const rows = table();
    return {
        async issue(credential) {
            insert(rows, credential);
        },
        async claim() {
            await tick();
            return null;
        },
    };
}

/** Expires a second early: the off-by-one that rejects still-valid credentials. */
export function expiresEarlyStore(): ClaimStore<Row> {
    const rows = table();
    return {
        async issue(credential) {
            insert(rows, credential);
        },
        async claim({ id, now }) {
            await tick();
            const row = rows.get(id);
            if (!row || row.claimedAt !== null) return null;
            if (row.expiresAt !== undefined && row.expiresAt - 1_000 <= now) return null;
            row.claimedAt = now;
            return row;
        },
    };
}
