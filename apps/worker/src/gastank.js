import { publicClient, config, readGasTank } from '@retainer/chain';

/**
 * An empty gas tank stops all billing silently -- charges just start failing to
 * broadcast with no on-chain trace. Surface it loudly and early. The thresholds and
 * the measured registration cost live in @retainer/chain, shared with the dashboard
 * header and the registration route.
 */
export async function checkGasTank() {
  return readGasTank(publicClient(), config().executor);
}
