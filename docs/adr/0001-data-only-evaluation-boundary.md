---
status: proposed
---

# Keep generated scenarios as data outside the verdict boundary

v0.1 and v0.2 executed generated TypeScript and interpreted stdout markers from the same container, so generator-controlled strings and ordinary target logs could resemble trusted verdict data. v0.3 accepts only a schema-valid `NightmareSeed`, lets trusted code resolve provenance and construct an `ExecutionPlan`, and accepts a candidate verdict only from a separate structured result channel because reachability evidence and product output must not be able to authorize their own classification.

## Considered options

Keeping stdout markers preserves the existing runner but cannot authenticate the marker source. Executing generated assertions gives the generator control over both the scenario and its oracle. Letting the target process create the final verdict also combines observed behavior with trusted classification. These options were rejected in favor of a fixed interpreter, registered fixture and action adapters, a trusted invariant evaluator, and host-side validation of the result artifact.

## Consequences

v0.3 needs a separate harness and image namespace, canonical data digests, evaluator build attestations, and marker-forgery regression tests. Raw stdout and stderr remain evidence but never decide the result. A malicious target package deliberately impersonating the dedicated result channel is a supply-chain threat outside this version, and reproduction on another physical host remains follow-up work.
