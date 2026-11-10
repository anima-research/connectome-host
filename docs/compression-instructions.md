# Recipe compression instruction templates

> **Companion draft — dependency-blocked, not release-ready.** Requires the
> context-manager instruction-template PR and a release containing its exported
> types, validator and strategy implementation. Published CM 0.27.0 does not
> contain this API. The host currently locks CM 0.25.0 / agent-framework 0.33.0;
> even published AF 0.34.0 still depends on CM 0.25.x. Installing only a newer
> direct CM validator does not upgrade AF's strategy. Before merging/releasing,
> AF must release with a compatible dependency on the feature-containing CM,
> then host must update both direct dependency floors and both lockfiles and
> rerun the integration tests without local overrides. No future version is
> assumed by this draft; its manifests deliberately remain unchanged.

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
built-ins. `default` is the only accepted preset. An empty `templates: {}` is
invalid: omit it instead.

An explicit nonblank `participant` is required only when a custom template uses
a `{participant}` placeholder; the host does **not** infer it from `agent.name`,
`summaryParticipant` or history. It does not change the existing summary
voice/ownership settings.

## Slots and substitutions

| Slot | Placeholders |
| --- | --- |
| `opening` | `participant` |
| `chunk`, `witnessedChunk` | `participant`, `targetTokens` |
| `readingChunk` | `participant`, `targetTokens`, `totalTokens` |
| `merge`, `witnessedMerge` | `participant`, `targetTokens`, `sourceLevelShown`, `targetLevel` |
| `readingMerge` | merge placeholders plus `totalTokens` |
| `transition` | `participant`, `targetTokens`, `context` |

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
  `frontdesk` overrides ordinary L1 wording, and `passthrough` does not compress;
  both reject even an empty or default `compressionInstructions` object.
- Unrelated strategy keys retain their existing admission behavior, including
  ignored keys and retired-field warnings, with or without templates. The
  forwarding list is not a strict schema for those keys. Strict validation
  applies to the new `compressionInstructions` settings, not all recipe keys.
- Custom extension strategy factories still receive the whole strategy object
  verbatim and own its validation/semantics. Acceptance there is not a claim
  that the host implements templates for that extension.
- The host imports the type and validator from CM and still constructs the
  class re-exported by AF. It does not implement a template engine or a custom
  dependency loader. The integration test requires AF's constructor to be the
  same feature-capable CM class, then captures a native mock summarizer request.

Templates are trusted instructions, not an enforcement mechanism or a security
boundary. They do not migrate existing summaries or promise provider behavior
or summary quality. Large templates consume the existing request budget.
