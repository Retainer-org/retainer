import { formatEther } from 'viem';
import { publicClient, config } from '@retainer/chain';

// A routed charge costs roughly 150k-180k gas (measured on Base mainnet).
const GAS_PER_CHARGE = 180_000n;
const WARN_BELOW_CHARGES = 100n;
const HALT_BELOW_CHARGES = 5n;

/**
 * An empty gas tank stops all billing silently -- charges just start failing to
 * broadcast with no on-chain trace. Surface it loudly and early.
 */
export async function checkGasTank() {
  const cfg = config();
  const client = publicClient();
  const [balance, fees] = await Promise.all([
    client.getBalance({ address: cfg.executor }),
    client.estimateFeesPerGas(),
  ]);
  const costPerCharge = GAS_PER_CHARGE * fees.maxFeePerGas;
  const remaining = costPerCharge > 0n ? balance / costPerCharge : 0n;

  const level = remaining < HALT_BELOW_CHARGES ? 'CRITICAL'
              : remaining < WARN_BELOW_CHARGES ? 'WARNING' : 'ok';

  return {
    level, executor: cfg.executor,
    balanceEth: formatEther(balance),
    estimatedChargesRemaining: Number(remaining),
    costPerChargeEth: formatEther(costPerCharge),
  };
}
