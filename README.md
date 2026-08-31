# single-use

[![CI](https://github.com/Yasirdora/single-use/actions/workflows/release.yml/badge.svg)](https://github.com/Yasirdora/single-use/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@yasirdora/single-use.svg?style=flat)](https://www.npmjs.com/package/@yasirdora/single-use)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)


**Prove your one-time credentials are actually one-time.**

A dependency-free conformance suite for single-use token redemption. Point it at your store, and it answers a question your existing tests almost certainly do not: *can two concurrent callers redeem the same credential?*

```bash
npm i -D @yasirdora/single-use
```

---

## The bug it looks for

Every auth system has credentials that must be redeemable exactly once — OAuth authorization codes, password-reset tokens, magic links, email verification, device codes, invites, idempotency keys, vouchers. The natural way to write redemption is also the wrong way:

```ts
const row = await store.find(id);        // 1. read
if (!row || row.usedAt) return null;     // 2. decide
await store.markUsed(id);                // 3. write
return row;                              // 4. act
```

Between 1 and 3 there is a window. Two callers can both read the row as unused, both decide to proceed, and both act. **One credential, two sessions.**

That window is not exotic. It is reached by a double-clicked button, a client retry, two tabs, a load-balanced pair of app servers, a mail scanner fetching a link while the recipient clicks it, or an attacker deliberately racing a captured credential.

The fix is to make the claim a single guarded statement, so the decision and the write happen under one lock:

```sql
UPDATE credential SET used_at = :now
 WHERE id = :id AND used_at IS NULL AND expires_at > :now
RETURNING *
```

The `WHERE` is the compare, the `SET` is the swap, and the database performs both atomically.

**Why this survives to production:** the difference between the two is invisible to a type checker, invisible in review, and invisible in any test that exercises one caller at a time. It is only visible under concurrency.

---

## Quick start

```ts
import { checkSingleUse } from "@yasirdora/single-use";

const report = await checkSingleUse({
  createStore: () => ({
    issue: ({ id, expiresAt }) => db.codes.insert({ id, expiresAt }),
    claim: ({ id, now }) => db.codes.claim(id, now),   // your real function
  }),
});

assert.ok(report.passed, report.summary);
```

Two methods. `issue` creates a credential; `claim` is the operation under test, and must return a non-null value **if and only if that caller won**. Everything else your system does — issuing, emailing, rate limiting, sessions — stays out of scope and does not need stubbing.

It returns a report rather than calling `expect`, so it runs under node:test, Vitest, Jest, Deno, Bun, or a plain script, and adds nothing to your dependency tree.

A failure tells you what happened and what to do:

```
1 of 10 single-use checks failed:
  ✗ concurrent claims elect exactly one winner
      round 3: 12 of 12 concurrent claims succeeded. THE CREDENTIAL IS NOT SINGLE USE.
      This is the read-then-write race: the liveness check and the write are
      separate operations, so two callers both read the credential as unused
      before either marks it.
      Express the claim as one guarded statement — `UPDATE ... SET used_at = :now
      WHERE id = :id AND used_at IS NULL` — and return a row only when it affected one
```

---

## What it checks

| Check | Catches |
|---|---|
| An issued credential can be claimed | A guard so strict nothing succeeds |
| An unknown credential is never claimed | Failing open on a missing row |
| Cannot be claimed twice in sequence | Single use not enforced at all |
| **Concurrent claims elect exactly one winner** | **The read-then-write race** |
| Stays claimed under a concurrent retry storm | State that resurrects a spent credential |
| Claiming one does not affect another | A guard matching more rows than its id |
| Concurrent claims on distinct credentials all succeed | An over-broad lock — safe, but serialises sign-in |
| An expired credential is never claimed | Expiry checked outside the guard |
| An unexpired credential is still claimable | An off-by-one that rejects valid credentials |
| Expiry cannot be raced | Time compared and written inconsistently |
| Exhausting the attempt budget retires it † | A budget checked outside the guard |
| Concurrent failed attempts each spend one try † | Lost decrements — free brute-force guesses |

† Skipped unless your adapter implements the optional `spendAttempt`.

Two of these are worth calling out because they are easy to miss in a hand-written race test. **Concurrent claims on distinct credentials** catches the opposite failure: a store that serialises every claim behind one global lock is perfectly safe and quietly turns sign-in into a queue. And **concurrent failed attempts** matters wherever the secret is short enough to guess — a lost decrement is a free guess, and read-then-write on a counter loses them under exactly the conditions an attacker creates.

---

## Why it repeats the race

By default each race runs **20 rounds of 24 concurrent claimants**.

A single trial is weak evidence. Whether two callers actually interleave depends on where the implementation happens to await, which varies with driver, pool state and load — so one clean pass can be luck. Repetition is what makes a green result mean something, and it is the main thing this gives you over a race test written by hand.

```ts
await checkSingleUse({ createStore, rounds: 100, concurrency: 64 });
```

The clock is injected and fixed by default, so failures reproduce. A store that reads the wall clock internally rather than the `now` it is handed will fail the expiry checks — correctly, because it cannot be tested deterministically and will drift in production.

---

## Honest limits

**A pass is evidence, not proof.** This is dynamic testing: it demonstrates that a race exists, and it cannot demonstrate that one does not. A store that is correct against SQLite may still be wrong at `READ COMMITTED` on Postgres with a different statement. Run it against the database you deploy on.

**It tests your adapter, not your endpoint.** If the atomic claim is correct but your handler calls it twice, or checks expiry again afterwards in application code, that is outside what this sees.

**It says nothing about the rest of your auth.** Entropy, hashing, transport, session handling and rate limiting are all out of scope. This verifies exactly one property, and verifies it properly.

---

## The suite holds itself to the same standard

A conformance suite that only ever runs against a correct implementation proves nothing — every check would pass if it always returned "ok".

So the test suite carries a corpus of deliberately broken stores, each violating exactly one property, and asserts that **every check fails against at least one of them**. Two of those stores are broken in the *restrictive* direction rather than the permissive one, because without them the checks asserting a live credential is claimable at all would never be exercised.

That meta-test earns its place: it found two checks in this package that were unproven the first time it ran.

The suite is also verified against real SQLite, not just in-memory doubles. The same table, the same data, one difference in how the claim is written — guarded `UPDATE` passes, `SELECT`-then-`UPDATE` fails — because a JavaScript object's "atomicity" is really the single-threaded event loop, and that is true by accident rather than by construction.

---

## API

```ts
checkSingleUse<T>(harness: Harness<T>): Promise<Report>
```

| Option | Default | |
|---|---|---|
| `createStore()` | required | Returns a fresh, empty store. Called once per check |
| `teardown(store)` | — | Cleanup after each check |
| `concurrency` | `24` | Concurrent claimants per race |
| `rounds` | `20` | How many times each race repeats |
| `epoch` | `1700000000000` | Injected clock base, so failures reproduce |

`Report` is `{ passed, results, summary }`; each result is `{ name, passed, skipped, detail }`.

---

## License

MIT
