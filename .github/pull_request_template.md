## Summary

<!-- What changed and why (1–3 bullets). -->

-

## Test plan

<!-- From `pnpm verify:status` (AGENTS.md, "Testing"). Keep the four apart: a recheck is not a full pass of the final code. -->

- Full run (`pnpm verify:ready`): revision and input state, result and duration
- Repairs after it: what was fixed
- Targeted rechecks (`pnpm verify:recheck`): what they reran, result
- CLI scenarios: run locally only for agent API changes (result), otherwise "CI"
- Known failures, if any: which, and the evidence they are not this change's
- CI on the final commit: required before merge
