# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the major version is 0, the minor version is treated as the breaking
slot: 0.1.x to 0.2.0 may break, 0.1.0 to 0.1.1 will not.

## [Unreleased]

## [0.1.0] — 2026-08-31

Initial release.

### Added

- `checkSingleUse` — a conformance suite for single-use credential redemption.
  Twelve checks against a two-method adapter, reporting rather than throwing so
  it runs under any test runner and adds no dependency.
- The headline check repeats the race by default (20 rounds × 24 claimants),
  because a single trial can be won by scheduling luck and is weak evidence.
- Checks for the two failures a hand-written race test usually misses: an
  over-broad lock that serialises every claim, and lost decrements on the
  attempt counter.
- Injected, fixed clock so failures reproduce.
