# Domain glossary

## NightmareSeed

Untrusted, data-only scenario input produced by a generator.

## NightmareSpec

Trusted, self-contained execution data created from a validated seed, registrations, and trusted transformations.

## ExecutionPlan

Trusted interpreter input derived from a validated `NightmareSpec`.

## Invariant

A product expectation with provenance that exists independently of the generated scenario.

## Public reachability

The ability to create and observe a state using declared package exports, registered public actions, and allowed environmental seams in a clean packed-package consumer.

## Violation identity

The normalized product behavior used to decide whether repeated runs and reduced specs show the same invariant violation. It excludes unstable logs, stacks, timestamps, and arbitrary messages.

## Confirmed counterexample

A derived state for a candidate that passes every execution, reproduction, reachability, oracle, minimization, and human-verdict gate. It is not a status supplied by a generator or evaluator.

## Independent reproduction

A separate session that rebuilds the evaluator for the same evaluation contract key and observes the same violation identity from the recorded spec and replay path.

## Historical preservation

The recorded ability to retain v0.2 evidence and, when available, the exact image or a separately identified best-effort rebuild. Preservation status and replay result are different facts.
