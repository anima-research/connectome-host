/**
 * Household-gateway telemetry headers (x-gate-* stamps).
 *
 * The data boundary these headers exist under: a household inference gateway
 * records them into its ledger and STRIPS them before the vendor — the vendor
 * must never see them. That boundary is only real if the host refuses to
 * attach the stamps anywhere else, so attachment is double-gated:
 *
 *   1. `GATE_TELEMETRY=1` — the operator's explicit declaration that the
 *      configured base URL is such a gateway. Absent/false ⇒ never attach.
 *   2. `ANTHROPIC_BASE_URL` actually set — the flag alone must not stamp
 *      traffic that would go to the vendor's default endpoint.
 *
 * Fail-closed on both (review finding on the first wiring: the stamp was
 * attached unconditionally, so with no base URL configured the value went
 * straight to the vendor).
 */

/** Truthy env-flag parse: unset/''/'0'/'false' (any case) are off. */
function envFlag(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

export function gateTelemetryHeaders(
  env: Record<string, string | undefined>,
  pendingDebtChunks: () => number | null,
): (() => Record<string, number | null>) | undefined {
  if (!envFlag(env.GATE_TELEMETRY)) return undefined;
  if (!env.ANTHROPIC_BASE_URL) return undefined;
  return () => ({ 'x-gate-debt-chunks': pendingDebtChunks() });
}
