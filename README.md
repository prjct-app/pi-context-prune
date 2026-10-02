# pi-context-prune

[![pi-context-prune — for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-local-extensions/main/pi-context-prune/docs/cover-v2.png)](https://pi.dev)

Remove superseded pi-memory snapshots from Responses-style request payloads in stable batches. Optional reasoning pruning is off by default.

## Install

Requires Pi with `before_provider_request` and `cache_warming_decision` events, and Node.js 22.19+:

```sh
pi install npm:@prjct.app/pi-context-prune
```

Reload Pi after installation. Install `pi-memory` separately to use its `/memory prune` action and memory panel integration.

## Defaults and configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `PI_PRUNE` | enabled | Set to `0` to disable both pruning paths. |
| `PI_PRUNE_MEMORY` | enabled | Set to `0` to keep superseded memory snapshots. |
| `PI_PRUNE_MEMORY_ADVANCE` | `3000` | Estimated superseded tokens needed for an automatic batch. |
| `PI_PRUNE_REASONING` | disabled | Set to `1` to prune older provider reasoning items. |
| `PI_PRUNE_KEEP` | `10` | Recent reasoning items protected from pruning. |
| `PI_PRUNE_ADVANCE` | `20000` | Estimated removable reasoning tokens needed for a batch. |
| `PI_PRUNE_DEBUG` | disabled | Set to `1` to show pruning figures. |
| `PI_SWITCH_WARN_TOKENS` | `50000` | Context size that triggers the model-switch cache warning. |

Set variables before starting Pi. Pruning changes the outgoing payload, not the saved session. It only handles payloads with an `input` array; other formats pass through unchanged. Manual memory pruning keeps the latest snapshot and recall.

The package also adjusts cache-warming decisions from model cost information and offers an interactive model-switch guard: compact first, stay on the current model, or switch anyway. `PI_PRUNE=0` disables pruning, not these cache controls. Pricing must be present in the model configuration for meaningful estimates.

Reasoning pruning reduces uploaded bytes; it is not a promise of billed-token savings and can affect reasoning continuity.

## Development

From the repository root: `node scripts/build-pi.mjs pi-context-prune`.

License: [MIT](LICENSE).
