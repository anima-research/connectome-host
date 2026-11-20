# Recipe compression instruction templates

This option requires a Context Manager (CM) release exporting
`CompressionInstructions` and `validateCompressionInstructions`, with the
matching strategy implementation. The host and agent-framework (AF) must resolve
to the **same CM class**. A validator in only the host's copy is insufficient.
See [dependency compatibility](#dependency-compatibility) for release prerequisites;
this guide describes the feature, not a claim that a compatible release exists.

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

There are two **conditional** release routes; neither is selected here:

1. A feature backport to CM **0.25.x** may satisfy existing AF ranges:
   AF 0.33.0 declares `^0.25.0`, and AF 0.34.0 declares `^0.25.1`. If a
   feature-containing patch is released and qualified there, the host can
   raise its CM floor and relock to a deduplicated copy without necessarily
   requiring an AF release. For reference, #648's initial host manifest asks
   for `^0.25.3` and **both lockfiles resolve 0.25.3**, not 0.25.0; 0.25.0 is
   AF 0.33.0's range floor.
2. A feature release on a **newer CM main line** may not fit existing AF
   ranges. It then requires AF and host dependency alignment as well as host
   relocking; installing a newer direct CM alone is not sufficient.

A textually clean application to a backport branch does not establish runtime
or behavioral equivalence. If a backport is chosen later, main-pinned CM
goldens need recapturing and qualification against that base. No feature
release version or backport decision is assumed here.

At dependency-bump time, maintainers must record the actual feature-containing
CM release and compatible AF ranges, update the host CM floor (and AF floor if
needed), both lockfiles and the dependency-range test, and rerun stock load,
typecheck/build and integration checks **without substitutions**. Recheck this
guide's route/range information, the docs index, resident memory guide and
changelog wording against the chosen implementation; remove any temporary
release staging notices. Local/PR staging must continue to track the missing
API as a release blocker until those checks pass.

Templates are trusted instructions, not an enforcement mechanism or a security
boundary. They do not migrate existing summaries or promise provider behavior
or summary quality. Large templates consume the existing request budget.
