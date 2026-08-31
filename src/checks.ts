/**
 * The checks.
 *
 * Each returns null when satisfied, or a sentence describing the violation.
 * They are written to be read by whoever gets the failure: the message says
 * what happened, what it means, and what to do, because the person seeing it
 * is often meeting this class of bug for the first time.
 */

import type { ClaimStore, Harness } from "./types.ts";

export interface Context {
    readonly store: ClaimStore;
    readonly now: number;
    readonly concurrency: number;
    readonly rounds: number;
    /** Fresh, unique id. */
    id(): string;
}

export interface Check {
    readonly name: string;
    /** Skipped when the adapter does not implement the optional method. */
    readonly needs?: "spendAttempt";
    run(context: Context): Promise<string | null>;
}

/** Counts non-null results, which by contract means "this caller won". */
const winners = (results: readonly unknown[]): number =>
    results.filter((result) => result !== null && result !== undefined).length;

export const CHECKS: readonly Check[] = [
    {
        name: "an issued credential can be claimed",
        run: async ({ store, now, id }) => {
            const credential = id();
            await store.issue({ id: credential });
            const claimed = await store.claim({ id: credential, now });
            return claimed === null || claimed === undefined
                ? "claim returned null for a freshly issued, unexpired credential — " +
                      "nothing else in this suite can pass until claiming works at all"
                : null;
        },
    },

    {
        name: "an unknown credential is never claimed",
        run: async ({ store, now }) => {
            const claimed = await store.claim({ id: "id-that-was-never-issued", now });
            return claimed === null || claimed === undefined
                ? null
                : "claim returned a value for an id that was never issued. A claim must " +
                      "fail closed: if the lookup finds nothing, nobody won";
        },
    },

    {
        name: "a credential cannot be claimed twice in sequence",
        run: async ({ store, now, id }) => {
            const credential = id();
            await store.issue({ id: credential });

            const first = await store.claim({ id: credential, now });
            const second = await store.claim({ id: credential, now: now + 1 });

            if (first === null || first === undefined) return "the first claim failed";
            return second === null || second === undefined
                ? null
                : "the same credential was claimed twice. Single use is not enforced at " +
                      "all — this fails even without concurrency, so the guard is missing " +
                      "rather than racy";
        },
    },

    {
        name: "concurrent claims elect exactly one winner",
        run: async ({ store, now, id, concurrency, rounds }) => {
            // The headline check, and the reason this package exists.
            //
            // Repeated, because a single race can be won cleanly by luck: where
            // two callers interleave depends on where the implementation
            // happens to await, which varies with driver and pool state. One
            // clean trial is not evidence.
            for (let round = 0; round < rounds; round++) {
                const credential = id();
                await store.issue({ id: credential });

                // Started without awaiting in between, so they interleave at
                // every suspension point inside the implementation.
                const results = await Promise.all(
                    Array.from({ length: concurrency }, () =>
                        store.claim({ id: credential, now }),
                    ),
                );

                const won = winners(results);
                if (won === 0) {
                    return `round ${round + 1}: no caller won the race, though the ` +
                        "credential was live. A claim that can lose to itself will " +
                        "reject legitimate redemptions under load";
                }
                if (won > 1) {
                    return (
                        `round ${round + 1}: ${won} of ${concurrency} concurrent claims ` +
                        "succeeded. THE CREDENTIAL IS NOT SINGLE USE.\n" +
                        "      This is the read-then-write race: the liveness check and " +
                        "the write are separate operations, so two callers both read the " +
                        "credential as unused before either marks it.\n" +
                        "      Express the claim as one guarded statement — " +
                        "`UPDATE ... SET used_at = :now WHERE id = :id AND used_at IS NULL` " +
                        "— and return a row only when it affected one"
                    );
                }
            }
            return null;
        },
    },

    {
        name: "a claimed credential stays claimed under a concurrent retry storm",
        run: async ({ store, now, id, concurrency }) => {
            // Distinct from the race above: here the credential is *already*
            // claimed before the storm starts. An implementation that resets
            // or re-reads state incorrectly can resurrect it.
            const credential = id();
            await store.issue({ id: credential });

            const first = await store.claim({ id: credential, now });
            if (first === null || first === undefined) return "the initial claim failed";

            const results = await Promise.all(
                Array.from({ length: concurrency }, () =>
                    store.claim({ id: credential, now: now + 1 }),
                ),
            );

            const won = winners(results);
            return won === 0
                ? null
                : `${won} of ${concurrency} claims succeeded against an already-claimed ` +
                      "credential";
        },
    },

    {
        name: "claiming one credential does not affect another",
        run: async ({ store, now, id }) => {
            // Catches a guard keyed on something non-unique, and a lookup that
            // matches more rows than intended.
            const first = id();
            const second = id();
            await store.issue({ id: first });
            await store.issue({ id: second });

            const claimedFirst = await store.claim({ id: first, now });
            if (claimedFirst === null || claimedFirst === undefined) {
                return "claiming the first credential failed";
            }

            const claimedSecond = await store.claim({ id: second, now: now + 1 });
            return claimedSecond === null || claimedSecond === undefined
                ? "claiming one credential invalidated an unrelated one — the guard is " +
                      "matching more rows than its id"
                : null;
        },
    },

    {
        name: "concurrent claims on distinct credentials all succeed",
        run: async ({ store, now, id, concurrency }) => {
            // The inverse failure, and one no other check would catch: a store
            // that serializes every claim behind one global lock passes every
            // safety check above while quietly turning sign-in into a queue.
            // Correctness and throughput are both part of the contract.
            const ids = Array.from({ length: concurrency }, () => id());
            for (const credential of ids) await store.issue({ id: credential });

            const results = await Promise.all(
                ids.map((credential) => store.claim({ id: credential, now })),
            );

            const won = winners(results);
            return won === ids.length
                ? null
                : `only ${won} of ${ids.length} distinct credentials could be claimed ` +
                      "concurrently. Each was live and independent, so a lost claim means " +
                      "the guard is over-broad — locking a table where it should lock a row";
        },
    },

    {
        name: "an expired credential is never claimed",
        run: async ({ store, now, id }) => {
            const credential = id();
            await store.issue({ id: credential, expiresAt: now + 1_000 });

            const claimed = await store.claim({ id: credential, now: now + 1_001 });
            return claimed === null || claimed === undefined
                ? null
                : "a credential was claimed after its expiry. Expiry must be part of the " +
                      "guard, not a check in calling code";
        },
    },

    {
        name: "an unexpired credential is still claimable",
        run: async ({ store, now, id }) => {
            // Guards against the trivial way to pass the previous check.
            const credential = id();
            await store.issue({ id: credential, expiresAt: now + 1_000 });

            const claimed = await store.claim({ id: credential, now: now + 999 });
            return claimed === null || claimed === undefined
                ? "a credential one millisecond short of expiry was rejected"
                : null;
        },
    },

    {
        name: "expiry cannot be raced",
        run: async ({ store, now, id, concurrency }) => {
            // Claims arriving exactly at the boundary must agree with each
            // other. Either all fail or exactly one succeeds; what must never
            // happen is several succeeding because the comparison and the
            // write disagree about the time.
            const credential = id();
            await store.issue({ id: credential, expiresAt: now + 1_000 });

            const results = await Promise.all(
                Array.from({ length: concurrency }, () =>
                    store.claim({ id: credential, now: now + 1_000 }),
                ),
            );

            const won = winners(results);
            return won <= 1
                ? null
                : `${won} claims succeeded at the exact expiry boundary`;
        },
    },

    {
        name: "exhausting the attempt budget retires the credential",
        needs: "spendAttempt",
        run: async ({ store, now, id }) => {
            const credential = id();
            await store.issue({ id: credential, maxAttempts: 3 });

            for (let i = 0; i < 3; i++) {
                await store.spendAttempt?.({ id: credential, now: now + i });
            }

            const claimed = await store.claim({ id: credential, now: now + 10 });
            return claimed === null || claimed === undefined
                ? null
                : "a credential was claimed after its attempt budget was spent. The " +
                      "budget must be part of the guard: an attacker who exhausts it and " +
                      "then guesses correctly should still lose";
        },
    },

    {
        name: "concurrent failed attempts each spend one try",
        needs: "spendAttempt",
        run: async ({ store, now, id }) => {
            // A lost decrement is a free guess. Read-then-write on the counter
            // loses them under exactly the conditions an attacker creates by
            // submitting guesses in parallel.
            const budget = 6;
            const credential = id();
            await store.issue({ id: credential, maxAttempts: budget });

            await Promise.all(
                Array.from({ length: budget }, () =>
                    store.spendAttempt?.({ id: credential, now }),
                ),
            );

            const claimed = await store.claim({ id: credential, now: now + 10 });
            return claimed === null || claimed === undefined
                ? null
                : `${budget} concurrent failed attempts did not exhaust a budget of ` +
                      `${budget}. Decrements are being lost, so an attacker submitting ` +
                      "guesses in parallel gets more than the budget allows";
        },
    },
];

/** Applies the harness defaults. */
export function resolve<T>(harness: Harness<T>): {
    concurrency: number;
    rounds: number;
    epoch: number;
} {
    return {
        concurrency: Math.max(2, harness.concurrency ?? 24),
        rounds: Math.max(1, harness.rounds ?? 20),
        epoch: harness.epoch ?? 1_700_000_000_000,
    };
}
