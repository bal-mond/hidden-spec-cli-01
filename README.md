[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bal-mond/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bal-mond/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`mend` applies an edit that an AI model wrote to a tree of text files. It
reads all four formats to one contract (`SPEC.md` in the kit):

- unified diffs, often with wrong line numbers,
- SEARCH/REPLACE blocks,
- V4A patches,
- JSON tool calls.

Edits are applied atomically: every file changes, or none does. The CLI
finds the lines an edit names even when the model drifted their whitespace
or indentation.

## Verification

- 100/100 practice checks pass (practice score 1000).
- 48/48 hand-built edge cases pass, covering spec sentences the practice
  set does not show.
- Deterministic: running the CLI twice on the same input gives
  byte-identical exit code, stdout and file tree.

## Licence

MIT — see `LICENSE`.
