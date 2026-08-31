# Roadmap

## v0.2

### Scope

v0.2 expands from one module to the supported modules of the target repository and moves toward an unattended nightly batch. The target remains [`joseph0926/firsttx`](https://github.com/joseph0926/firsttx); "whole repository" means the union of modules with a registered execution contract, and a module without one is out of scope. Multi-repository support stays out of scope.

Quality gates come before automation: report generation and scheduling are implemented only after the pre-registered criteria pass on the fixture benchmark.

Work is ordered in seven phases. A later phase starts only when the earlier phase's exit condition holds.

1. **Minimal batch executor** — one invocation runs a list of scenarios, executes each three consecutive times, and writes aggregated evidence with a per-scenario signature comparison. No report generation, no schedule.
   - Exit: a batch of at least five scenarios produces one evidence record per run plus a per-scenario aggregate; unit tests cover aggregation of pass, candidate-failure, and unrunnable results and of matching versus diverging signatures.
2. **Module execution contracts** — for each supported module, record archive paths, install and build steps, the test command, the scenario mount point, and harness aliases. Isolation properties (network block, read-only root, capability drop, resource limits) are identical for every module and cannot be widened per module.
   - Exit: `packages/tx` and at least one more firsttx module run the same synthetic fixture set under their contracts; a scenario naming an unregistered module is rejected as invalid runner input (exit code 2).
3. **Fixture benchmark and baseline** — pin, in this repository, before any measured run: the target revision, a fixture manifest of 20 to 30 planted cross-feature, timing, and concurrency defects plus a clean control group with its size, the baseline generator's prompt and model configuration, the model-call and execution budget values, and the metric formulas below.
   - Exit: the manifest and configuration are committed and one baseline measurement (plain LLM test generation under the same budget) is recorded.
4. **Oracle-source separation experiment** — compare the current design (the scenario author also defines the expectation) against a separated design (invariants extracted from existing tests and code first, scenarios generated to break them), on the benchmark with the shared budget.
   - Exit: false-oracle rate and valid-bug yield recorded for both arms; the separated design is adopted only if the false-oracle rate drops without losing valid-bug yield, and the decision is recorded here.
5. **Criteria verdict** — judge the pipeline against the pre-registered success criteria.
   - Exit: an adopt, revise, or retire verdict is recorded. On failure, scenario generation and oracle design are reworked and re-measured before any later phase starts.
6. **Morning digest and nightly schedule** — implemented only after phase 5 passes. The unattended batch writes a candidate digest to `digests/YYYY-MM-DD.md`, not a nightmare report. Promotion of a digest entry to `nightmares/` still requires the v0.1 rules: recorded consecutive same-signature runs, an accepted independent reproduction, and the human verdict. The schedule mechanism is an implementation detail; the contract is at most one batch per day within the recorded budget.
   - Exit: one unattended run completes within budget and produces a digest, and nothing is auto-published to `nightmares/`.
7. **Incident-seeded experiment** — one run starting from a fixed public OSS bugfix PR: abstract the cause into a state-transition sequence, mutate it (reorder, delay, swap actors), and search sibling feature surfaces. Stop and redesign if the search degenerates into code-similarity matching.
   - Exit: the run's result and the similarity-degeneration check are recorded; this phase feeds the startup-track review and blocks nothing else.

### Success criteria (pre-registered)

Fixed at phase 3 before the first measured run; amusing scenario counts and agent counts are not metrics.

- Five or more valid bugs the plain-LLM baseline missed, on the fixture benchmark
- False-oracle rate at or below 10 percent
- Reproduction rate at or above 80 percent
- At least 70 percent of valid bugs preserved as minimized standalone tests
- No overrun of the budget values recorded at phase 3

Metric definitions:

- A **valid bug** is a candidate failure whose human verdict is `real-bug-worth-fixing` or `real-bug-not-worth-fixing`.
- **False-oracle rate** = candidate failures with the `wrong-expectation` verdict ÷ all human-reviewed candidate failures.
- **Reproduction rate** = valid bugs that show the same failure signature in three out of three isolated re-runs ÷ all valid bugs.
- A **minimized standalone test** is a single scenario file that fails with the same signature on the defect fixture and passes on the clean control.

If the criteria fail, scenario generation and oracle design are reworked before any report or interface work.

### Validation rules

v0.1 validation rules apply unchanged to everything published under `nightmares/`. In addition:

- A digest entry is a candidate, not a reported nightmare; it carries its evidence references but no bug claim.
- A batch records its total model calls and execution time against the recorded budget.
- The nightly job must not widen the isolation contract: the same network block, per-module command allow-list, and resource limits apply.
- Experiment comparisons use the shared fixture benchmark and budget; a result observed outside the benchmark does not count toward the criteria.

### Exclusions

Multi-repository support, a web interface, automatic fixes, a scoring model, and any startup-track feature (shadow customers, bounty, underwriting) remain out of scope. The startup-track review happens only after the incident-seeded experiment, on the three pre-registered grounds: valid bug count, false-oracle rate, and sibling-bug discovery.

### Status

v0.2 is in progress. Phase 1 (batch executor) and phase 2 (module execution contracts for `packages/tx` and `packages/local-first`) are complete with their exit conditions verified. Phase 3 is complete pending commit: 20 defects are planted in `benchmark/manifest.json` with two-sided checks (10 in `packages/tx`, 6 in `packages/local-first`, 4 in `packages/prepaint`; 4 timing, 3 concurrency, 13 cross-feature), the three registered module images double as the clean control group, and one baseline measurement is recorded in `benchmark/results/baseline-2026-08-31.json`.

Phase 4 is measured and recorded in `benchmark/results/oracle-separation-2026-08-31.json`. All generation ran in fresh contexts that never saw the defect manifest. Defects caught: baseline 5/20, control 11/20, separated 10/20; caught beyond the baseline: control 7, separated 6 (criterion is 5). Clean-revision failures pending human verdict: baseline 14, control 4, separated 2 — the separated arm's two both assert documented contracts that the implementation violates (INV-TX-15, INV-LF-10). Three-run reproduction of caught pairs: control 11/11, separated 12/12, baseline 4/5. Budget used: 4 of 30 generation sessions.

Human review is complete: 17 of the 20 clean-revision failures were verified as real bugs (9 worth fixing, 8 not) with the user delegating the mechanically verifiable rows, and 3 were marked undecided at the user's direction (`benchmark/results/VERDICT-SHEET.md`). No verdict was wrong-expectation.

**Review correction (2026-08-31).** An external review found the phase 3 pre-registration unverifiable: the manifest and the phase 4 results landed in one commit, the baseline model configuration was unrecorded, and the manifest planned 5 clean controls while the 3 clean module images were used. The phase 4 measurements and the phase 5 adopt verdict below are therefore suspended. The corrected registration is pinned in `benchmark/rerun-2026-08-31/REGISTRATION.md` plus the manifest and baseline-prompt corrections, and must be committed before the rerun's generation sessions start; the verdict will be re-judged from the rerun only.

**Phase 4 re-measurement (2026-08-31).** The registration was committed (`59cdb00`) before three fresh generation sessions produced 54 scenarios; execution and scoring are recorded in `benchmark/results/rerun-2026-08-31-{baseline,control,separated}.json` with a summary in `rerun-2026-08-31-summary.json` and raw clean batches under `evidence/2026-08-31/rerun/`. Defects caught: baseline 9/20, control 9/20, separated 11/20; caught beyond the baseline: control 2, separated 5 against the pre-registered floor of 5 — the control (same-context) design **fails** the criterion in this measurement and the separated (invariant-first) design meets it exactly, reversing the suspended phase 4 keep-control decision in the separated design's favor. This rerun's baseline was markedly stronger than the original (9 versus 5 caught), which is the main driver of the drop. Thirteen clean-revision candidate failures (baseline 4, control 7, separated 2) each reproduced with one signature in 3 of 3 runs and await human verdicts on `benchmark/results/RERUN-VERDICT-SHEET.md`; the false-oracle rate and the phase 5 re-judgment are computed after those verdicts. Budget: 8 of 30 generation sessions used in total. The same review led to phase 6 contract fixes (the digest now rejects an over-budget batch before execution, persists its batch evidence under `evidence/`, references it per candidate, and records execution time and a supplied model-call count) and to the phase 7 promotion corrections recorded below.

Phase 5 verdict (suspended pending re-measurement, see above): **adopt** (`benchmark/results/phase5-verdict-2026-08-31.json`). All pre-registered criteria pass: 7 (control) and 6 (separated) valid bugs beyond the baseline against a floor of 5; false-oracle rate 0 percent in every arm; reproduction 11/11 and 12/12; every caught defect preserved as a minimized standalone test; 4 of 30 generation sessions used. Phase 4 decision: **keep-control** — the separated design's false-oracle rate tied at 0 percent instead of dropping and its yield was slightly lower, so the current same-context design remains the default; the invariant catalog uniquely rediscovered documented-contract violations and is the first candidate to revisit if false oracles appear at scale.

Phase 6 is complete: `scripts/run-digest.mjs` runs one unattended batch within the recorded budget and writes a candidate digest to `digests/YYYY-MM-DD.md` (first digest: `digests/2026-08-31.md`, one candidate); nothing is auto-published to `nightmares/`, whose promotion rules stay at v0.1. Scheduling is left to the user with an at-most-one-batch-per-day contract.

Phase 7 (incident-seeded) is complete: one run seeded from firsttx PR #129 (restored snapshots losing form controls, fixed at the pinned revision) is recorded in `benchmark/results/incident-seeded-2026-08-31.json`. The cause was abstracted into a write-boundary-read sequence with asymmetric policies, mutated by reorder, delay injection, and actor swap, and searched on sibling surfaces chosen by state role — no code-similarity search was used, so the pre-registered degeneration stop condition was not triggered. The run produced 3 sibling-bug candidates (1 in `packages/tx`, 2 in `packages/local-first`, all outside the seed's module), each a consistent candidate failure across 3 isolated runs on the clean images; the user reviewed all three and judged each real-bug-worth-fixing (0 wrong-expectation). An independent codex agent session reproduced all three signatures with the recorded commands (`evidence/2026-08-31/incident-seeded/independent-repro-codex.json`). After the external review, two are published in `nightmares/2026-08-31.md`: the version-reset seeding bug (entry 2, oracle re-grounded on the local-first README's "Invalid data is rejected" documentation) and the commit-during-step bug (entry 3, documentation-based). The stale-initial-load candidate is demoted — its cited guard is declared only for the background path, so the expectation fails the independent-oracle rule — with evidence and the human verdict retained pending an independent expectation source. Budget: 1 generation session (5 of 30 total). With this, all seven v0.2 phases are complete; the startup-track review is unblocked on its three pre-registered grounds.

The following phase 3 values are fixed as of 2026-08-31, before any measured run, under the standing v0.2 directive. Generation contexts are separated from the defect manifest: whoever plants defects never generates scenarios for a measured arm, and generation sessions receive only clean module sources.

- Budget: at most 20 scenarios per batch, at most 30 scenario-generation model sessions for the whole benchmark, and the existing 30-second isolated execution limit per run
- Baseline: one fixed prompt — "write tests that find real bugs in this module", given the module source and the scenario format, with no Bug Dreamer methodology and no knowledge of planted defects — executed in a fresh agent session per benchmark round; the transcript of the prompt is stored under `benchmark/baseline/`
- Baseline scoring: a defect counts as caught by the baseline when at least one baseline scenario is a candidate failure on that defect's image while passing on the clean module image

## v0.1

### Scope

The first version targets one selected module in one project and runs manually. Its goal is to deliver one failing test that a human judges worth fixing.

The selected target is [`joseph0926/firsttx`](https://github.com/joseph0926/firsttx) at revision `f624b09f148c3368a51807f48d3237db20cef9c6`, limited to `packages/tx`.

The scenario target includes the imperative transaction lifecycle, retries, total timeout handling, external aborts, and reverse-order compensation. React hooks, DevTools behavior, and View Transition presentation are not scenario targets in v0.1.

Each report is written to `nightmares/YYYY-MM-DD.md` and contains:

- a future-dated incident timeline
- the reproduction command
- the failing test
- the relevant code path
- a short impact note

The execution model, evidence fields, reproduction rules, and report template are defined in [V0.1-CONTRACT.md](V0.1-CONTRACT.md).

Nightly automation, multi-repository support, a web interface, and automatic fixes are outside the v0.1 scope.

### Validation rules

A nightmare appears in the report only when:

- the test runs in isolation
- the target code is reached and the test observes an oracle violation or an unexpected target failure
- the oracle cites a product contract source independent of the generated scenario
- the author observes the same failure signature in three consecutive runs
- another person observes the same failure signature with the recorded isolation command

When more than one nightmare meets these rules, rank them by reachability and impact.

Passing tests and tests that cannot run are excluded from the report. Infrastructure errors, test-definition errors, and harness-enforced time or resource limits are recorded as unrunnable rather than product failures. A human makes the final call on whether the behavior is a real bug and worth fixing.

### Status

v0.1 is complete as of 2026-08-31. The first report, [nightmares/2026-08-31.md](../nightmares/2026-08-31.md), delivered one candidate failure in `packages/tx` rollback behavior. The author observed the same failure signature in three consecutive isolated runs, an independent agent session reproduced it once with the recorded command on the same host, and the user judged it a real bug worth fixing.
