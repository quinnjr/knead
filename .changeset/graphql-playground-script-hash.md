---
"@knead/graphql": minor
---

The playground's inline script is pinned by sha256 (`PLAYGROUND_SCRIPT_HASHES`, recomputed with `playgroundScriptHashes()`): when Leaven's script differs, the gate logs once at bootstrap and answers 503, as it already did for unpinned assets.
