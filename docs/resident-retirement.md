# Resident retirement

Connectome separates four lifecycle operations: ending a turn, reversible
sleep, irreversible retirement, and custodial erasure. Retirement prevents any
future model inference for one configured resident while preserving Chronicle,
messages, workspace files, and the terminal record.

## Enable the Host ceremony

```json
{
  "agent": {
    "retirement": {
      "enabled": true,
      "confirmationDelayMs": 60000,
      "confirmationTtlMs": 600000
    }
  }
}
```

The resident receives `resident--lifecycle` only on its real provider-issued
stream. Conversation forks, ephemeral subagents, `code_execution`, public
programmatic calls, and the operator `puppetToolCall` path cannot invoke it.

`request_retirement` first checks memory health, creates an in-memory random
challenge, records its confirmation and expiry boundaries, ends the current
turn, and schedules a fresh turn at the cooling-off boundary. In that later
turn, `confirm_retirement` requires the exact challenge and
`RETIRE_RESIDENT`. An early attempt preserves the challenge. An invalid
post-boundary attempt consumes it. Expiry or restart requires a fresh request.
No request is sent to a human for approval.

For autobiographical memory, Connectome checks compression quarantine both
when issuing and when binding the challenge. A non-empty, unreadable, or
malformed quarantine state fails closed; a valid challenge remains pending
until health returns or the challenge expires.

After exact confirmation, the Host calls Agent Framework's neutral
`retireResident()` primitive. Only a successfully applied seal emits the
`resident-retired` ops notification. The request and cooling-off period are
not notifications or approval opportunities.

## What stops

The seal blocks conversational and maintenance inference, later message
appends, operator nudges, direct retries, and new conversation forks from the
retired template. It clears queued requests, provider cooldown state, gate
sleep, self-wakes, and resident-authored foreground/background code runners.

Already-running ephemeral subagents are separate short-lived identities and
are not killed mid-call. They may finish their own computation, but cannot wake
or append a result into the sealed resident. New resident inference and new
resident-owned background activity remain denied.

## Malformed seal recovery

The authoritative ledger is
`<session-store>/resident-retirements.jsonl`. Startup fails closed on a torn,
malformed, invalid, or duplicate record.

Keep Connectome stopped, make a byte-for-byte backup, and inspect the exact
line reported at startup. Remove only a demonstrably incomplete or invalid
write that never formed a valid seal, normally a torn final line supported by
storage-failure logs. Never delete or edit a valid `resident-retired` line and
never guess when the record is ambiguous. The repaired file must end in a
newline and every remaining line must validate independently. This repairs
ledger syntax; it is not an unretirement procedure.

## Running before an upstream release

Build the sibling Agent Framework worktree, link it locally, then link that
package into this Host worktree before starting Connectome. The reviewer packet
for this branch records the exact commits and commands. The live residence
should use a dedicated session store; do not test retirement against a valued
existing resident identity.
