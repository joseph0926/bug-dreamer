# Phase 4 Execution Plan

Status: **policy approved and registered, implementation unsealed**

The approved policy is recorded in `benchmark/v0.3/registration.json`; the approval-time draft remains at `benchmark/v0.3/phase4-policy.draft.json`. The registration is intentionally `approved-unsealed`: unresolved eligible row, retention denominator, adapter, checkpoint, author-bundle, sealed-ref, image, and epoch fields remain null. It authorizes implementation of the registered policy, not measured authoring or execution. `fast-check` remains disabled.

## Outcome and immediate gate

Phase 4 is intended to produce one complete, pre-registered benchmark epoch covering generic versus invariant-first authoring, operator effect, and direct-materializer-to-interpreter retention. Every approved experiment must end in `adopt`, `revise`, or `retire`; `benchmark` validation and an independent scorer recomputation must pass.

The scope gate was approved by the user on 2026-09-05:

- The current Phase 2 catalog is a minimal `packages/tx` vertical slice. `docs/V0.3-CONTRACT.md:102` explicitly assigns expansion of the adopted pipeline to every registered module to Phase 5.
- The historical 20-defect inventory spans `packages/tx`, `packages/local-first`, and `packages/prepaint`, but only the timeout defect is currently fully expressible through the v0.3 path with an independently supported oracle. Historical private checks for local-first and prepaint are not reusable as proof of public reachability or oracle eligibility.
- A tx-only run can be a smoke test. It cannot be presented as the complete Phase 4 benchmark required by the ROADMAP.

Approved scope: Phase 4 may prepare only the public action, fixture, invariant, and comparison adapters needed to evaluate the registered three-module benchmark. Phase 5 remains the clean real-module application of the adopted procedure and the independent reproduction of public candidates. The user subsequently approved the arm meanings, numeric budgets, exhaustive verdict rules, and review protocol recorded below. Unresolved eligibility and adapter IDs are implementation outputs to freeze before Checkpoint A, not permission to alter the approved rules.

## Fixed constraints

- `docs/ROADMAP.md` owns phase scope, ordering, final verdicts, and status.
- `docs/V0.3-CONTRACT.md` owns input, trust, execution, evidence, result axes, replay, minimization, publication, and validator behavior.
- `docs/adr/0001-data-only-evaluation-boundary.md` requires generators to emit data only. Generated data, target logs, and ordinary product files cannot authorize a verdict.
- `benchmark/v0.3/registration.template.json` is a frozen historical template. The actual policy lives in `benchmark/v0.3/registration.json`.
- The evaluator limit is 30 seconds, 1 MiB per stdout and stderr stream, and at most 4096 recorded bytes per stream. The approved aggregate measurement maximum is 460 Docker evaluations and 18,000 monotonic seconds.
- Adding `fast-check` requires separate user approval. It is disabled and outside the current policy bundle; no dependency or arm is created for it, and this review does not ask for that decision again.
- The v0.1/v0.2 runtime, registration, historical results, and evidence remain frozen.
- Generated tests and target commands never run on the host. Measurement uses isolated, image-ID-pinned containers with the registered network, command, time, resource, secret, and Docker-socket restrictions.
- Before Phase 4 reuses or rebuilds a defect evaluator under an evaluation contract key, the defect build-input closure must directly bind the canonicalizer files actually copied into the image, their aggregate digest, and the registered lockfile integrity, matching the clean evaluator path. The current final image IDs fix the bytes that produced existing Phase 3 results, and version and budget declarations are transitively coupled through the recorded source digest, so this is not a claim that those results are ambiguous. It is a reproducible-rebuild gap that must be closed and re-sealed before measured Phase 4 authoring or execution.

## Work status and independence

All review and implementation tasks use `gpt-5.6-sol` with reasoning effort `medium`.

| Work | Task ID | Current role | Blind-generator eligibility |
| --- | --- | --- | --- |
| Contract design | `01a06f53-181f-71e1-b0e8-181cd7d3c19a` | Registration analysis and this execution-plan proposal | Never reuse |
| Execution/scorer design | `01a06f53-1a66-7273-af6a-b25d99fbfa91` | Common I/O, measurement, and scoring review | Never reuse |
| Independence review | `01a06f53-1d05-7ed0-aa5a-2579508fef77` | Reachability review and local-first adapter | Never reuse |
| Scorer and evidence validation | `01a06f80-360c-7690-97b2-7d99430da13e` | Scorer, evidence validation, and benchmark validator CLI | Never reuse |
| tx adapter | `01a06f88-ea82-7e22-98cf-16cede06a7cb` | Public tx D/E adapters and source review | Never reuse |
| prepaint adapter | `01a06f89-7ff0-7811-acb9-ce93c774a6ba` | Public prepaint D/E adapters and source review | Never reuse |
| Spec and authoring preparation | `01a06f90-9365-7563-bc50-53c56f31110e` | Data-only spec, trust classifier, and clean context preparation | Never reuse |

These tasks have seen historical defects or planning conclusions. A measured generator must be a new task with no inherited turns and only the sealed clean author bundle.

## Approved registration policy

The following rules are fixed by the approved-unsealed registration. Scorer, runner, adapter, and image implementation may realize these rules but may not revise them.

### Arm meanings

The approved mapping is:

| Arm | Approved meaning | Comparison |
| --- | --- | --- |
| `G` | Generic data-only seed authoring through the identity interpreter path | `G` versus `P` |
| `P` | Invariant-first data-only seed authoring through the identity interpreter path | Procedure baseline |
| `A` | Frozen `P` seeds with `time.advance/v1` under a fixed request policy | `P` versus `A` |
| `B` | Frozen `P` seeds with `schedule.release-order/v1` under a fixed request policy | `P` versus `B` |
| `C` | Frozen `P` seeds with `fault.step-outcome/v1` under a fixed request policy | `P` versus `C` |
| `D` | Eligible rows through the comparison direct materializer | Paired `D` versus `E` |
| `E` | The same rows through the trusted interpreter | Paired `D` versus `E` |

`G` and `P` have equal model and evaluation opportunities; `P/A/B/C` share one seed set; `D/E` are paired row for row. Operator request enumeration and all arm and row orders are deterministic and frozen before Checkpoint A.

### Universe and eligibility

The independent static inventory now records 20 historical defects at SHA-256 `898a82d28e534a839886de993bc8bfeca59ca876516e923156bebd3e52aaedbe`: 10 tx, 6 local-first, and 4 prepaint rows. Only the development-exposed timeout row is currently supported by the interpreter. Fifteen rows have a confirmed source in the static audit, while five have an unconfirmed oracle or a boundary conflict. These are draft audit facts, not registered metric eligibility. The registration keeps all 20 rows even when they are ineligible and does not present any of these historical known claims as blind discovery.

Each inventory row should record:

```text
id, partition, moduleRegistrationId, targetRevision, sourceKind,
patchDigest, historicalCheckRef, publicActionEligibility,
fixtureEligibility, invariantEligibility, oracleSourceRefs,
comparisonMaterializerEligibility, interpreterEligibility,
duplicateGroup, metricEligibility, exclusionReason
```

Partitions are registered as:

- `development`: anything used to design or tune the v0.3 path, including the Phase 3 timeout spike. These rows are diagnostic and never contribute to discovery yield.
- `existingPublic`: historical planted defects and published findings. They contribute only to metrics whose eligibility gates they pass.
- `heldOutTemporal`: rows selected by a pre-registered cutoff and selection procedure whose patch, check, and results remain hidden from authoring tasks.

An ineligible row remains in the normalized result set with an exact reason such as `missing-public-action`, `missing-public-fixture`, `oracle-not-independent`, `private-check-only`, or `duplicate-truth`. Both the full inventory and eligible subset counts are reported. Empty held-out membership yields `not-applicable` temporal metrics and prohibits blind-yield claims.

Before Checkpoint A, register a static ordered `retentionDenominatorRowIds` list containing only rows with an independently supported oracle, public action and fixture path, comparison materializer, interpreter path, and normalized observation identity. Its current draft value is pending adapter and oracle review. No E-side rejection, timeout, unrunnable result, not-run state, clean regression, or different identity can remove a registered row from that denominator. A D anchor failure also preserves the row and blocks pipeline adoption.

### Author bundle and exposure rule

The author bundle should bind exact prompts, clean source and public-contract digests, action and invariant catalogs, `gpt-5.6-sol` with `medium` reasoning, fresh session IDs, allowed inputs, rejected paths, user-visible task-turn counts, ordered seed outputs, and every accepted or rejected seed digest. Internal model-call, token, compute, and search-effort counters are unavailable and must remain `null` with a reason. Equal visible task turns do not prove compute parity.

Measured authoring tasks may receive clean source, public documentation, public tests/types, approved invariant identifiers, the action catalog, and the seed schema. They must not receive:

- `benchmark/manifest.json`, historical checks, patches, results, or truth tables;
- `evidence/`, `digests/`, `nightmares/`, Phase 3 spike/reduction truth, or earlier arm outputs;
- Git history, diffs, issues, PRs, or external pages that reveal benchmark fixes;
- any review or implementation task conversation or summary, including the orchestration task.

The generator cannot assert provenance, choose a target revision, define an oracle, set a budget, or change policy. The trusted host validates the data-only seed and supplies registered provenance and execution policy.

### Approved limited-demo budget and thresholds

The approved policy gives one fresh session and one visible task turn to each of G and P, at most two seeds per module per authoring arm, one operator request per P seed in each of A/B/C, and no replacement for rejected seeds. Initial paired execution is capped at 310 Docker evaluations: 46 for each of G/P/A/B/C and 40 for each of D/E. G/P/A/B/C replay at most the first two pre-ordered canonical truth candidates per arm; E replays every frozen retention-denominator row, up to 20. Each replay is five runs separate from the initial observation. D receives no replay. The replay maximum is 30 candidates times 5, so the complete measurement maximum is `310 + 150 = 460` Docker evaluations and `460 * 30 = 13,800` timeout-seconds, under an 18,000-second overall measurement cap including cleanup allowance.

Image preparation is separate from the 460 measurement runs and all scores. The approved policy caps it at 24 builds, 72 inspect or probe containers, zero tolerated failed preparation attempts, and 7,200 elapsed seconds. It records build, inspect, probe, failure, cleanup, cleanup-failure, and elapsed counts. A known single-patch F-to-P check is the initial clean-defect pair; an extra patch artifact cannot run without a new registered budget.

The approved formulas and ordered verdict branches cover:

- unique eligible defect catch rate;
- valid-bug yield per one declared authoring unit;
- false-oracle rate after independent review;
- five-of-five reproduction rate;
- operator replay-confirmed IDs minus P's complete raw two-sided observation set;
- operator applicability and clean-side failure rates;
- paired interpreter retention of the registered violation identity;
- unrunnable rate and every resource's budget utilization.

A zero denominator produces `not-applicable`, not numeric zero. Development rows never contribute to adoption yield. Raw two-sided candidates may select pre-registered replay rows but never support adoption. Each strategy uses exhaustive first-match branches: epoch-integrity failures abort; non-repairable trust failures retire; incomplete evidence, zero denominators, insufficient coverage, normal budget exhaustion, excessive infrastructure failures, clean regressions, and repairable issues revise; then adopt and sufficient-counterevidence retire rules apply; every other combination revises.

### Truth-table minimum

The scorer contract must cover every audit row and consumed budget unit:

- matching initial defect failure, clean pass, and known-patch F-to-P pass: raw two-sided candidate only;
- that raw candidate plus five separate matching defect replays: replay-confirmed catch;
- defect pass: miss;
- clean candidate failure: two-sided failure, not caught;
- different defect violation identity: nonmatching violation, not caught;
- schema/catalog/policy rejection: recorded invalid or inapplicable result;
- evaluator error or unrunnable run: not a product bug and still charged to execution budget;
- zero to four matching separate replays: incomplete and not confirmed;
- missing or disputed oracle: review-blocked, not a valid bug;
- duplicate truth: retained but counted only by its canonical duplicate group;
- no remaining budget: scheduled row records `budget-exhausted` and `not-run`;
- retention: only an E row with five separate matching replays enters the numerator; every frozen denominator row remains in the denominator through preserved identity, different violation, clean regression, pass/loss, rejection, unrunnable, and not-run states;
- D is a two-sided comparison anchor only, never a replay-confirmed or public catch;
- an incomplete P initial pair blocks operator incrementality rather than treating a P observation outside its replay quota as an operator-only discovery.

No row is deleted after execution. An exclusion is a recorded terminal row with a registered reason. Clean results may be shared only for identical seed, request, resolved action and invariant semantics, fixture state, target artifact, evaluator key, and plan policy. Each artifact still gets its own catalog-bound spec and plan and may have different digests. A rejected module seed is not replaced; insufficient module coverage yields revise.

## Common I/O contract before parallel implementation

The registration, scorer, evaluator, and runner must first agree on one immutable interface:

- canonical registration and epoch-closure schema;
- ordered universe-row and arm identifiers;
- canonical seed, transformation request, spec, plan, trusted result, run record, budget ledger, normalized measurement row, score, and verdict schemas;
- result-axis and reason-code enums;
- digest domains and exact byte canonicalization;
- deterministic path layout and execution order;
- rules for partial, stopped, and aborted epochs.

Proposed ownership paths, subject to contract approval:

| Concern | Proposed owned paths |
| --- | --- |
| Registration and universes | `benchmark/v0.3/registration.json`, `benchmark/v0.3/universe.json`, `benchmark/v0.3/truth-commitments.json`, `benchmark/v0.3/arms/*.json` |
| Author bundle contract | `contracts/v0.3/benchmark-author-bundle-cases.json`, `benchmark/v0.3/authoring/` |
| Shared I/O and registration validation | `src/v03-benchmark-contract.mjs`, `contracts/v0.3/benchmark-registration-cases.json` |
| Scoring | `src/v03-benchmark-score.mjs`, `contracts/v0.3/benchmark-score-cases.json` |
| Evaluator adapters | module-specific files under `harness-v0.3/benchmark/`, registrations under `registrations/v0.3/benchmark/` |
| Host measurement runner | `src/v03-benchmark-runner.mjs`, `scripts/run-v03-benchmark.mjs` |
| Image preparation and resealing | `scripts/prepare-v03-benchmark.mjs`, a Phase 4 Dockerfile under `docker-v0.3/` |
| Validation | `src/v03-benchmark-validation.mjs`, `scripts/validate-v03.mjs`, `test/v03-benchmark-*.test.mjs` |
| Raw and scored results | `evidence/v0.3/phase4/`, `benchmark/v0.3/results/` |

No two parallel tasks edit the same file. Changes to evaluator inputs require the contract-defined preparation procedure to reseal evaluation contract keys before measurement.

## Implementation DAG

All implementation tasks use `gpt-5.6-sol`, reasoning effort `medium`. Rows with the same stage may run in parallel only after their shared predecessor is complete.

| Stage | Work | Dependencies | Completion condition |
| --- | --- | --- | --- |
| 0 | Approved scope allocation and owning ROADMAP/CONTRACT update | Phase 3 stable | Complete: Phase 4 and Phase 5 ownership is unambiguous |
| 1 | Registration policy draft and premeasurement independence review | Stage 0 | Arms, complete audit inventory, eligibility, exposure, checkpoints, and open numeric-policy work are reviewable; no implementation exists |
| 2 | Numeric budgets, formulas, truth tables, thresholds, reason codes, and common I/O approval | Stage 1 | Every score-affecting choice is fixed before code and measured authoring |
| 2.5 | Close defect evaluator canonicalizer build-input closure in the existing spike preparation and replay-validation ownership paths | Independent contract-integrity finding | Complete: the defect key binds the copied canonicalizer file list, aggregate digest, and package integrity; affected Phase 3 evidence was re-sealed and the restored 189 tests and six validators passed |
| 3A | Registration/epoch validation in its proposed owned files | Stages 2 and 2.5 | Synthetic positive and negative registration cases pass |
| 3B | Pure scorer in its proposed owned files | Stages 2 and 2.5 | Every truth-table, denominator, budget, and verdict fixture recomputes deterministically |
| 3C | Module-specific public benchmark adapters in separate files | Stages 2 and 2.5 | Adapter mechanics pass development-only synthetic fixture pairs that are disjoint from the registered 20-row truth inventory; no historical truth row is executed or credited before the measured epoch, and no Phase 5 real application occurs |
| 3D | Host runner and evidence normalization in separate files | Stages 2 and 2.5 | Serial order, image ID use, cleanup, complete row ledger, and budget exhaustion pass synthetic tests |
| 4 | Integrate `benchmark` CLI and CI validation | Stages 3A-3D | One development-only synthetic epoch over non-benchmark fixtures passes; missing/extra/tampered rows and keys fail, without executing or scoring any registered historical truth row |
| 5 | Prepare and reseal evaluator images and contract keys | Stage 4 | Registered image IDs and full evaluation contract keys validate, including direct agreement between the clean and defect canonicalizer closures |
| 6 | User confirms Checkpoint A | Stage 5 | Approved registration and implementation are committed before authoring |
| 7 | Fresh blind `G/P` authoring | Stage 6 | Complete validated author bundle exists with no deny-list exposure |
| 8 | User confirms Checkpoint B and seal | Stage 7 | Author bundle and execution manifest are committed and sealed before measurement |
| 9 | Serial Docker measurement | Stage 8 | Every row and budget unit has a normalized terminal or explicit non-execution record |
| 10 | Independent verdict review and scorer recomputation | Stage 9 | Independent output agrees with the registered scorer rule |
| 11 | Evidence-backed ROADMAP verdict | Stage 10 | `benchmark` returns 0 and ROADMAP records terminal verdicts by evidence reference |

Stage 2.5 was completed early because an independent review found a pre-existing contract-key closure gap whose correction did not depend on Phase 4 arm, budget, or outcome policy. It changed shared Phase 3 evidence and therefore ran serially through the existing preparation contracts before Phase 4 implementation. The clean key remains `0c08c61bbef849abb799afffb717e72779b3a7427165389e475326061b67064f`; the corrected defect key is `842cf233cff4f1d69df6b3b061ab87fd51951a44c22f6efec904ba97e44d2050`. Its re-sealed spike and reduction observations are prerequisite evidence only and cannot enter Phase 4 scores. Recompute draft registration references before Checkpoint A.

Measured authoring tasks must open only a separately prepared clean bundle, not this repository checkout: repository instructions and status documents themselves contain historical outcomes. The author-bundle review must verify the task's automatically supplied context as well as its explicit file reads.

## Checkpoints and epoch identity

The required order is exact:

```text
approved contract and implementation
-> Checkpoint A
-> fresh blind authoring
-> Checkpoint B and sealedRef
-> serial measurement
-> independent review and scorer recomputation
-> ROADMAP verdict
```

A commit cannot contain its own hash. Use a non-self-referential scheme:

- Checkpoint A is the full object ID of the user-created commit containing approved registration policy, implementation, development-only synthetic validation, the canonicalizer-closure correction and required affected-evidence re-seals, and sealed evaluator identities. At minimum those re-seals include the Phase 3 spike and dependent reduction; Phase 2 is included only if a Phase 2-owned input changes. A later receipt records it. It contains no Phase 4 measured result from a registered historical truth row. The required Phase 3 re-seals retain their own registration and are prerequisite evidence only, never Phase 4 observations.
- Checkpoint B is the full object ID of the user-created commit containing the complete author bundle and execution manifest. A later seal receipt records it.
- `sealedRef` is a predeclared immutable ref name that resolves to Checkpoint B; a movable branch is insufficient.
- `benchmarkEpochId` is a domain-separated digest over Checkpoints A and B, resolved sealed ref, registration bytes, universe and truth commitments, author-bundle digests, evaluator contract keys including their canonicalizer file, aggregate, and lock-integrity closure, platform, scorer version, and execution order. It excludes itself and all measured output.

The epoch closure must bind both Phase 3 spike and reduction registrations and evidence. Either define Checkpoint A as the explicit transitive binding or add approved reduction-reference fields to the actual registration schema.

Repository policy assigns Git writes to the user. Agents prepare exact checkpoint contents and verify them read-only; the user creates and confirms each checkpoint.

## Stop and abort rules

Abort the epoch immediately if a checkpoint, sealed ref, registration closure, author bundle, truth commitment, image identity, scorer digest, row order, or budget ledger does not match; if a measured author saw deny-listed truth; if an unregistered retry or extra resource unit occurs; if a policy or implementation change is required after results are visible; if unapproved fast-check code appears; or if Phase 4 work crosses into Phase 5 real-module application or public-candidate reproduction.

An aborted epoch preserves all partial rows and consumed budgets with the registered abort reason. It is never resumed after a policy or implementation change and never called complete. A replacement receives a new closure and epoch ID.

## Decision sequence

Do not ask the user to settle every policy at once.

1. **Complete: scope gate.** Phase 4 owns three-module benchmark-adapter preparation; Phase 5 owns clean real-module application and independent public-candidate reproduction.
2. **Complete: policy approval.** Arm meanings, exposure rules, budgets, truth tables, verdict order, user review, checkpoints, and disabled fast-check status are fixed in the approved-unsealed registration.
3. **Current implementation work.** Implement and statically validate the common contract, scorer, preparation path, runner, and module adapters; resolve and freeze eligible, retention, and adapter IDs before Checkpoint A without changing the approved policy.

## Completion criteria

Phase 4 is complete only when:

- its approved registration predates measured authoring and execution;
- Checkpoints A and B, sealedRef, author-bundle digests, truth commitments, evaluator keys, and epoch ID validate;
- all 20 historical defects remain visible in the audit inventory with explicit eligibility and exclusion states;
- every registered row and consumed budget unit appears exactly once in normalized evidence;
- all approved experiments have derived terminal verdicts and disabled experiments are not reported as successes;
- independent scorer recomputation agrees with checked-in output;
- `node scripts/validate-v03.mjs benchmark` returns 0;
- no tx-only smoke result is used as full Phase 4 evidence;
- no Phase 4 automation writes to `nightmares/` or claims Phase 5 independent reproduction;
- `docs/ROADMAP.md` records the evidence-backed verdicts and phase status.
