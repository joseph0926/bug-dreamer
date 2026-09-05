# Phase 4 implementation contract

## Status and ownership

The Phase 4 policy is approved and recorded in `benchmark/v0.3/registration.json` as `approved-unsealed`. It is not authoring-ready or measurement-ready: the eligible row IDs, retention denominator IDs, adapter registration IDs, Checkpoint A, author bundle, Checkpoint B, sealed ref, and benchmark epoch ID are intentionally absent. No benchmark result or completion claim exists.

`src/v03-benchmark-contract.mjs` owns the common registration, trusted-module, measurement-row, and budget-ledger validators. The existing tx-specific `src/v03-spec.mjs` stays unchanged. `src/v03-benchmark-spec.mjs` owns the separate three-module seed/spec/plan builder.

The immutable approved-policy projection has digest `4e1a92788ea6309d7075fafd20d636e479fcdd3d5352e787d80459375aa36701`. It excludes only stage state: status, frozen row and adapter IDs, truth-commitment reference, Checkpoints A and B, author-bundle digests, image identities, sealed ref, benchmark epoch ID, and derived readiness. Changing an arm, budget, formula, truth rule, verdict, review rule, interface, or execution order fails validation.

The interpreter and comparison paths are independent entrypoints. `harness-v0.3/benchmark/<module-id>-direct.mjs` must not import the benchmark spec, plan builder, interpreter entrypoint, or interpreter-only materializer. `harness-v0.3/benchmark/<module-id>.mjs` must not import the direct materializer. They may share only the registered module oracle, normalizer, result serializer, canonicalizer, and environment primitives. Import-closure validation must enforce this boundary before Checkpoint A.

## Current implementation checkpoint

The Phase 4 implementation now includes the three public module adapters, independent D/E entrypoints, data-only seed/spec/plan construction, isolated host runner, scorer, actual-evidence validator CLI, and clean authoring-context preparation. The implementation tasks used `gpt-5.6-sol` with `medium` reasoning. Module adapters ran in parallel; common contracts preceded integration, and image preparation and measurement remain sequential gates.

The source-reviewed inventory proposes 15 metric and retention rows, one development-only timeout diagnostic, and four blocked rows while preserving all 20 historical entries. These are static registration inputs, not measured catches. Truth commitments describe source-derived defect observations; independent module oracles separately define correct product behavior.

No Phase 4 Docker preparation, nominal image probe, fresh measured authoring, or benchmark measurement has run at this checkpoint. Evaluator image identities and Checkpoints A and B remain absent, and the registration remains `approved-unsealed`. The remaining implementation work is to connect frozen seed bodies and operator selection records to the measurement CLI and evidence writer. The host measurement core exists, but `run-v03-benchmark.mjs` deliberately refuses execution until that connection is complete. After it passes static integration checks, the prescribed image preparation must run its six clean nominal D/E probes. Only then can the user create Checkpoint A. No existing Phase 3 result substitutes for this work.

Final static verification on 2026-09-05 passed all 304 unit tests and the six existing validators (`history`, `contracts`, `spec`, `trust`, `operators`, `replay`). `benchmark` validation correctly returned exit 1 for the unsealed registration. These checks do not establish Docker execution or Phase 4 completion.

## Reused wire contracts

The benchmark reuses the existing schema versions and top-level shapes rather than inventing parallel envelopes:

- `NightmareSeed v1`: `{ schemaVersion, catalogVersion, id, invariantId, actors, actions }`. Each action is `{ actionId, actor, arguments, bind }`; `arguments` is validated by the selected module descriptor. API: `validateBenchmarkSeed(seed, descriptor) -> seed`, throwing a classified schema, catalog, or policy error.
- `NightmareSpec v1`: `{ schemaVersion, seedDigest, targetRegistrationId, invariantRegistrationId, catalogVersion, actors, baseActions, transformedActions, transformations, scheduleControls, fixtures, canonicalizer }`. The benchmark builder is `buildBenchmarkSpec(seed, descriptor, artifact) -> spec`. Specs are artifact-specific.
- `ExecutionPlan v1`: `{ schemaVersion, specDigest, targetRegistrationId, invariantRegistrationId, targetArtifactDigest, evaluatorId, normalizedObservedKind, observedFields, actions, bindings, fixtureSetup, virtualTime, scheduleControls }`. API: `buildBenchmarkPlan(spec, descriptor, artifact) -> plan`. Plans are artifact-specific; clean and defect spec and plan digests may differ.
- `TrustedResult v1`: reuse the existing payload shape, result-channel reader, output limits, and digest rules. Do not call the current `validateTrustedResult` or `classifyTrustedResult` for benchmark rows: both invoke the tx-specific Phase 2 spec and plan validators. `src/v03-benchmark-trust.mjs` exposes `validateBenchmarkTrustedResult(result, plan, spec, descriptor) -> result` and `classifyBenchmarkTrustedResult({ resultBytes, exitCode, timedOut, outputTruncated, plan, spec, descriptor }) -> { status, reason, result }` using `src/v03-benchmark-spec.mjs`. Module-specific normalized data stays inside the existing `returned-value` observation as `{ value: <canonical JSON> }`; no new trusted-result observation kind is introduced. A module evaluator returns only `OracleEvaluation`; the trusted serializer assembles the bound result and adds its payload digest.
- Run records use `validateRunRecord(record, { assert, label, extraKeys })`. They are evidence envelopes, not verdict authority.

## Trusted module descriptor and functions

`validateTrustedModuleDescriptor(descriptor) -> descriptor` accepts exactly:

```text
{
  schemaVersion, id, moduleId, packageName, importSpecifier,
  targetRegistrationPath, targetRegistrationSha256, catalogVersion,
  actions: [{ id, importSpecifier, adapterId, argumentSchemaId, bindingOutputType }],
  fixtures: [{ id, kind, materializerId, consumerActionId,
      payloadArgumentPointer, publicActionTrace }],
  invariants: [{ id, evaluatorId, sourceKind, sourceRef, sourceCommit,
    authoredBeforeGeneration, visibility, strength, corroboratingRefs,
    normalizedObservedKind, observedFields }],
  comparisons: [{ id, materializerId, invariantId,
    normalizedObservedKind, observedFields }]
}
```

Every `argumentSchemaId` is implemented by the registered pure module `harness-v0.3/benchmark/<module-id>-schema.mjs`. Its required `validateActionArguments({ action, bindings, policy }) -> void` export has no product or fixture-runtime imports and is consumed unchanged by both the host builder and evaluator; argument rules are not duplicated in a second schema representation. Every action names an `importSpecifier` present in its package registration's `allowedImportSpecifiers`; this admits the registered `@firsttx/prepaint/plugin/vite` public subpath while rejecting private subpaths. Each fixture's RFC 6901 `payloadArgumentPointer` selects its complete data-only canonical payload from the consumer action arguments and `publicActionTrace` records the public path; the empty pointer selects the whole arguments object. The builder combines that payload with the registered fixture fields, artifact identity, and consumer instance ID to create `FixtureRecord` synchronously. Every invariant is public, predates generation, and names its source. A corroborating invariant needs at least two independent references. A comparison must use the same normalized observation kind and fields as its invariant.

The interpreter entrypoint has exactly five exports and is checked by `assertTrustedInterpreterModuleImplementation(implementation, descriptor?) -> implementation`:

```text
descriptor
validateActionArguments({ action, bindings, policy }) -> void
materializeFixture({ fixtureRecord, actionInstance, artifact, policy }) -> Promise<FixtureRecord>
executeAction({ actionInstance, bindings, fixtures, scheduleControls, runtime }) -> Promise<Observation>
evaluateInvariant({ invariantRegistration, observation, plan }) -> OracleEvaluation
```

The direct comparison entrypoint has exactly two exports and is checked by `assertTrustedComparisonModuleImplementation(implementation, descriptor?) -> implementation`:

```text
descriptor
materializeComparison({ comparisonRegistration, row, artifact, policy, runtime }) -> Promise<Observation>
```

`bindings` is a `Map<string, { type, value }>` inside the trusted process. `artifact` is `{ role: "clean" | "single-patch-defect", targetArtifactDigest, evaluationContractKey }`. `FixtureRecord` is `{ registrationId, registrationDigest, kind, producerArtifact: { moduleRegistrationId, targetArtifactDigest }, publicActionTrace, canonicalWirePayload, materializerId, stateDigest, consumerActionInstanceId }`. `Observation` is `{ normalizedObservedKind: "returned-value" | "thrown-error", normalizedObservedFields }`. `OracleEvaluation` is exactly `{ execution: "pass" | "candidate-failure", observedKind: "returned-value" | "thrown-error", observedFields }`.

`runtime` is an explicit trusted evaluator dependency, never generator data or a field stored in a seed. Both callers pass it directly; adapters do not retrieve it from a process-global symbol.

The common interpreter applies E-side schedule controls once around action execution. Direct materializers retain their independent sequencing.

Module code never constructs spec digests, plan digests, violation identities, or result payload digests. The shared benchmark trust entrypoint validates the spec, plan, descriptor, and `OracleEvaluation`, then alone assembles the complete `TrustedResult v1` payload, violation identity, and payload digest.

`assertTrustedModuleImplementation` is a compatibility alias for the interpreter assertion. Extra exports are rejected. ES module namespace objects are accepted even though their prototype is null.

## Measurement and scoring input

`validatePhase4MeasurementRow(row) -> row` accepts exactly:

```text
{
  schemaVersion, epochId, sequence, armId, moduleId, inputId,
  canonicalTruthId, duplicateGroup, artifactRole, targetArtifactDigest,
  phase, replayIndex,
  executionPath, specDigest, planDigest, runRecordRef,
  axes: { specAcceptance, plan, evaluator, execution },
  observation: null | {
    normalizedObservedKind, normalizedObservedFields,
    violationIdentity, resultPayloadDigest
  },
  reasonCode,
  budget: { charged, evaluationOrdinal }
}
```

Completed pass and candidate-failure rows retain the raw normalized observation. Candidate failures also retain the SHA-256 violation identity. Rejections, not-run rows, and unrunnable rows cannot carry an observation. This prevents a scorer from trusting precomputed booleans such as `DValid` or `cleanRegression`.

The scorer's simple JSON input must contain these source facts, not derived rates or verdicts:

```text
{
  epochId,
  registrationStaticPolicyDigest,
  metricEligibleTruthIds,
  truthCommitments: [{ canonicalTruthId, moduleId, duplicateGroup,
    invariantRegistrationId, matcherId, expected: {
      normalizedObservedKind, normalizedObservedFields } }],
  retentionRows: [{ rowId, moduleId, canonicalTruthId, duplicateGroup }],
  acceptedSeedIds: { G, P },
  operatorRequests: [{ requestId, inputId, armId, moduleId, applicable, reasonCode }],
  replayCandidates: [{ armId, inputId, canonicalTruthId, started, expectedRuns: 5 }],
  measurementRows,
  userReviews: [{ canonicalTruthId, verdict }],
  trust: { status, reasonCode },
  epochAbort: null | { reasonCode, sequence },
  budgetLedger
}
```

Each truth commitment is sourced independently before generation and frozen by `universe.truthCommitmentRef` before Checkpoint A. `phase4ViolationIdentityDigest({ invariantRegistrationId, normalizedObservedKind, normalizedObservedFields, targetArtifactDigest }) -> sha256` combines that registered expectation with each row's actual artifact digest. The scorer compares this recomputed identity with the row's recorded violation identity; `canonicalTruthId` alone never proves a match.

`verdict` is one of `real-bug-worth-fixing`, `real-bug-not-worth-fixing`, `wrong-expectation`, or `undecided`. `trust.status` is `pass`, `repairable-failure`, or `non-repairable-failure`. Initial clean, defect, and known single-patch rows, replay starts and all five separate replay outcomes, D anchor observations, and E initial and replay observations are represented only by `measurementRows`. The scorer joins them by the registered arm, input, truth, artifact role, phase, and replay index and recomputes raw candidates, clean regressions, D anchor validity, E retention, replay confirmation, rates, and first-match verdicts.

`validatePhase4BudgetLedger(ledger) -> ledger` accepts `{ schemaVersion, epochId, generation, measurement, preparation, stoppedBy }`. It enforces the approved maxima: 460 measurement Docker evaluations, 30 replay candidates, 150 replay runs, 18,000 measurement seconds, 24 preparation builds, 72 combined inspect/probe operations, zero preparation failures, and 7,200 preparation seconds.

Common contract validators throw `V03BenchmarkContractError`; the independent evidence validator throws `V03BenchmarkValidationError`. The scorer, module adapters, seed/spec/plan builder, trust classifier, and isolated runner have separate synthetic regression tests. Those tests do not establish image readiness or a measured benchmark result. `benchmark` validation requires the sealed epoch and actual evidence; missing checkpoints or measurements must fail.

The execution manifest is committed at Checkpoint B and binds Checkpoint A. It cannot contain its own Checkpoint B object ID. The later epoch receipt binds B and the immutable tag, and validation compares the manifest bytes with the blob at B. Measured output is excluded from this closure.
