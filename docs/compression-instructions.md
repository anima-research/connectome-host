# Recipe compression instruction templates

This option requires a Context Manager (CM) release exporting
`CompressionInstructions` and `validateCompressionInstructions`, with the
matching strategy implementation. The host and agent-framework (AF) must resolve
to the **same CM class**. A validator in only the host's copy is insufficient.
See [dependency compatibility](#dependency-compatibility) for supported versions.

For the built-in `autobiographical` strategy, put trusted operator-authored
wording in `agent.strategy.compressionInstructions.templates`. No preset is
needed:

```json
{
  "name": "Example",
  "agent": {
    "name": "Participant",
    "strategy": {
      "type": "autobiographical",
      "compressionInstructions": {
        "templates": {
          "chunk": "Record the events in this slice, preserving attribution and unresolved questions. Target {targetTokens} tokens."
        }
      }
    }
  }
}
```

Omitting `type` selects autobiographical. Omitting `compressionInstructions`,
using `{}`, or selecting `{"preset":"default"}` preserves built-in wording.
A partial templates object changes only named slots; omitted slots keep the
built-ins. Coordinate `opening` and `chunk`: the built-in chunk refers back to
the most recent memory system notification supplied by `opening`. Replacing
only the opening can make that reference misleading.
`default` is the only accepted preset. An empty `templates: {}` is
invalid: omit it instead.

An explicit nonblank `participant` is required only when a custom template uses
a `{participant}` placeholder; the host does **not** infer it from `agent.name`,
`summaryParticipant` or history. It does not change the existing summary
voice/ownership settings.

## Slots and substitutions

| Slot | Used for | Placeholders |
| --- | --- | --- |
| `opening` | L1 record marker, including split pieces | `participant` |
| `chunk` | Ordinary/mixed L1 and split pieces | `participant`, `targetTokens` |
| `witnessedChunk` | Wholly inherited L1 and split pieces | `participant`, `targetTokens` |
| `readingChunk` | L1 portion of a larger sharded body | `participant`, `targetTokens`, `totalTokens` |
| `merge` | Ordinary/mixed consolidation and source-level refusal retries | `participant`, `targetTokens`, `sourceLevelShown`, `targetLevel` |
| `witnessedMerge` | All-witnessed consolidation and source-level refusal retries | same as `merge` |
| `readingMerge` | Consolidation of portions of a larger body; not source-level retries | merge placeholders plus `totalTokens` |
| `transition` | Transition summary (`generateTransitionSummary`); `targetTokens` is fixed at 1500, also the output cap | `participant`, `targetTokens`, `context` |

Split pieces use the parent chunk's ordinary/witnessed classification, even
for reading-mode chunks. Source-level retries use `merge`/`witnessedMerge`,
not `readingMerge`; `sourceLevelShown` is the actual source level (0 means raw
messages), and `targetLevel` is the level being produced. `totalTokens` counts
the larger sharded body. These slots change wording, not the split/merge algorithms.

Use single braces, e.g. `{targetTokens}`. Transition templates must contain
`{context}` exactly once. CM supplies numeric values from request construction
and substitutes once; inserted context and participant text are not reparsed.
There is no eval, executable JSON, brace escaping or expression language.
Unknown keys, malformed settings, blank templates and invalid placeholders are
rejected by **CM's shared validator** when the recipe is validated, before
strategy construction or any summarizer request. Errors for this boundary do
not echo arbitrary keys, participant names or template values.

CM's existing identity reminders still append. A truthy `witnessedInstruction`
and `templates.witnessedChunk` conflict and are rejected at recipe load.
Existing prompt, tool and request preparation behavior remains in force.
Settings are snapshotted by CM at construction, not hot-tuned.

## Strategy boundary and compatibility

- Only the built-in autobiographical strategy supports this host option.
  `frontdesk` overrides unwitnessed L1 wording but delegates witnessed L1 to
  CM. Rejecting this option for frontdesk as a whole is a conservative host
  choice, not a claim that every frontdesk instruction is overridden.
  `passthrough` does not compress. Both reject even an empty or default object.
- Unrelated strategy keys retain their existing admission behavior, including
  ignored keys and retired-field warnings, with or without templates. The
  forwarding list is not a strict schema for those keys. Strict validation
  applies to the new `compressionInstructions` settings, not all recipe keys.
- Custom extension strategy factories still receive the whole strategy object
  verbatim and own its validation/semantics. Acceptance there is not a claim
  that the host implements templates for that extension.
- The main resident, conversation forks, reader forks and the update store
  audit use `buildFrameworkStrategy` and receive this setting. Each fork gets
  a fresh strategy instance.
- Subagents do **not** inherit this setting: the host constructs
  `KnowledgeStrategy` from stored launch fields, without recipe templates.
  KnowledgeStrategy's phase-specific L1 and ordinary merge overrides would
  also take precedence over applicable CM templates if supplied separately.
- `scripts/warmup-session.ts` constructs an autobiographical strategy without
  reading this recipe option; warmup-generated import summaries use built-in
  wording. This option does not rewrite them later.
- The host imports the type, validator and reference class from CM, and
  constructs AF's re-export. When this option is present (even `{}` or
  `preset: "default"`), construction requires identical classes or throws a
  value-free deduplication error. This deliberately rejects separate copies
  even if both might support templates; it does not inspect private fields or
  probe a provider. Recipes omitting the option keep their existing behavior.
  Extension factories are outside this guard.

## Dependency compatibility

CM 0.29.0 includes the compression-instruction API (context-manager #486).
The host requires AF `^0.36.0` and CM `^0.29.0`; both lockfiles resolve one
shared CM 0.29.0. AF 0.35.x requires CM `^0.28.0`, so raising only the host's
CM dependency installs a second copy and does not enable templates.

Templates are trusted instructions, not an enforcement mechanism or a security
boundary. They do not migrate existing summaries or promise provider behavior
or summary quality. Large templates consume the existing request budget.
