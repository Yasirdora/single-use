/**
 * The contract under test.
 *
 * A single-use credential is one that must be redeemable exactly once: an
 * OAuth authorization code, a password-reset token, an email verification
 * link, a device code, an invite, an idempotency key, a voucher. The property
 * sounds trivial and is routinely got wrong, because the natural way to write
 * it is also the wrong way:
 *
 * ```ts
 * const row = await store.find(id);          // 1. read
 * if (!row || row.usedAt) return null;       // 2. decide
 * await store.markUsed(id);                  // 3. write
 * return row;                                // 4. act
 * ```
 *
 * Between steps 1 and 3 there is a window. Two callers can both read the row
 * as unused, both decide to proceed, and both act. In production that window
 * is reached constantly — a double-clicked button, a client retry, a mail
 * scanner fetching a link while the recipient clicks it, two tabs, a
 * load-balanced pair of app servers, or an attacker deliberately racing a
 * captured credential. The result is one credential granting two sessions.
 *
 * The fix is to make the claim a single guarded statement, so that the
 * decision and the write happen under one lock:
 *
 * ```sql
 * UPDATE credential SET used_at = :now
 *  WHERE id = :id AND used_at IS NULL AND expires_at > :now
 * RETURNING *
 * ```
 *
 * The `WHERE` is the compare and the `SET` is the swap. The database performs
 * both atomically, so exactly one concurrent caller sees a row come back.
 *
 * This package exists because that difference is invisible to a type checker,
 * invisible in review, and invisible in tests that exercise one caller at a
 * time. It is only visible under concurrency, which is why it survives to
 * production.
 */

/** A record that can be claimed exactly once. */
export interface Credential {
    /** Opaque identifier. The suite generates these; treat them as opaque. */
    readonly id: string;
    /**
     * Epoch milliseconds after which the credential must never be claimable.
     * Omitted means it does not expire.
     */
    readonly expiresAt?: number;
    /**
     * Failed attempts permitted before the credential is permanently retired.
     * Omitted means unlimited. Only meaningful when the adapter implements
     * {@link ClaimStore.spendAttempt}.
     */
    readonly maxAttempts?: number;
}

/**
 * The adapter you implement, wrapping whatever storage you already have.
 *
 * Deliberately two required methods. The property being verified needs a way
 * to create a credential and a way to claim one; everything else your system
 * does — issuing, rate limiting, emailing, session creation — is out of scope
 * and should not have to be stubbed to run this.
 */
export interface ClaimStore<T = unknown> {
    /** Persists a claimable credential. Called before each check. */
    issue(credential: Credential): Promise<void>;

    /**
     * The operation under test.
     *
     * Must return a non-null value **if and only if this caller claimed the
     * credential**. Returning the row, `true`, or an id are all fine; the
     * suite only distinguishes null from non-null.
     *
     * This is the whole contract, and the "only if" half is the half that
     * gets broken. A `claim` that returns the row whenever the row exists and
     * is unused *at the time of reading* will pass every sequential test and
     * fail under concurrency.
     *
     * Expiry and the attempt budget must be enforced **inside** the same
     * guarded statement. Checking them in calling code reintroduces the
     * window the guard exists to close.
     */
    claim(query: { readonly id: string; readonly now: number }): Promise<T | null>;

    /**
     * Records one failed redemption attempt, if your system limits them.
     *
     * Optional. When present, the suite additionally verifies that exhausting
     * the budget retires the credential and that concurrent failures each
     * count — a lost decrement is a free brute-force guess, which matters
     * whenever the secret is short enough to guess at all.
     */
    spendAttempt?(query: { readonly id: string; readonly now: number }): Promise<void>;
}

/** How to build a fresh store, and how hard to push it. */
export interface Harness<T = unknown> {
    /**
     * Returns an empty store. Called once per check, so state cannot leak
     * between them. Reuse a connection and clear the table if that is
     * cheaper than reconnecting.
     */
    createStore(): ClaimStore<T> | Promise<ClaimStore<T>>;

    /** Cleanup after each check. */
    teardown?(store: ClaimStore<T>): void | Promise<void>;

    /**
     * Concurrent claimants per race. @default 24
     *
     * Enough that a read-then-write implementation loses reliably rather than
     * occasionally.
     */
    concurrency?: number;

    /**
     * How many times each race is repeated. @default 20
     *
     * A single race can be won cleanly by luck: whether two callers interleave
     * depends on where the implementation happens to await, which varies with
     * driver, pool state, and load. One passing trial is weak evidence.
     * Repetition is what turns "did not fail this time" into a real signal,
     * and it is the difference between this and a hand-written race test.
     */
    rounds?: number;

    /**
     * Injected clock base, in epoch milliseconds. @default 1700000000000
     *
     * Fixed by default so failures reproduce. Every `now` the suite passes is
     * derived from this, so a store that consults the wall clock internally —
     * rather than the `now` it is given — will fail the expiry checks, which
     * is correct: it cannot be tested deterministically and will drift in
     * production.
     */
    epoch?: number;
}

/** One check's outcome. */
export interface CheckResult {
    readonly name: string;
    readonly passed: boolean;
    /** Why it failed, or how it was satisfied. */
    readonly detail: string;
    /** Whether the check was skipped because the adapter opted out. */
    readonly skipped: boolean;
}

export interface Report {
    readonly passed: boolean;
    readonly results: readonly CheckResult[];
    /** Human-readable digest, suitable as an assertion message. */
    readonly summary: string;
}
