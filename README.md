# Pi context controls

[![pi-context-prune — for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-local-extensions/main/pi-context-prune/docs/cover-v2.png)](https://pi.dev)

```sh
pi install npm:@prjct.app/pi-context-prune
```

Pi owns compaction. Payload pruning is disabled by default, preserving the full
conversation and encrypted reasoning across long sessions. Model switches keep
context; the extension reports cache cost without recommending compaction.

Legacy manual experimentation requires `PI_PRUNE=1`. It can be disabled again
with `PI_PRUNE=0`; reasoning pruning additionally requires `PI_PRUNE_REASONING=1`.
Automatic memory cleanup only considers earlier full rule snapshots, not ordinary
user requests quoting memory markup or separately retrieved passages.
