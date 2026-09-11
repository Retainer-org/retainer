import { formatEther } from 'viem';

/**
 * The executor's gas tank, in units of the work it pays for.
 *
 * The executor pays gas for two things: charges (the worker) and registrations (the
 * public sign page). An empty tank stops both with no on-chain trace, so it is read
 * in one place and shown where a person will see it -- the dashboard header -- and
 * registration closes before the tank gets low enough to threaten charging.
 *
 * A registration's cost is measured, not estimated: registration #24
 * (0xaebe8226847ce0b5779a239b3bc1b72bee2ddee0fece10dbdf2b00c8cb4a4172, a returning
 * MetaMask-upgraded account) used 98,336 gas plus a 31,477,998,711 wei L1 data fee.
 * A first registration also deploys the smart account and costs more; the margins
 * below are wide enough to absorb that.
 */
export const REGISTRATION_GAS = 98_336n;
export const REGISTRATION_L1_FEE_WEI = 31_477_998_711n;
export const REGISTRATION_MEASURED_IN = '0xaebe8226847ce0b5779a239b3bc1b72bee2ddee0fece10dbdf2b00c8cb4a4172';

// A routed charge costs roughly 150k-180k gas (measured on Base mainnet).
export const GAS_PER_CHARGE = 180_000n;

export const GAS_TANK_LIMITS = Object.freeze({
  warnBelowCharges: 100n,
  haltBelowCharges: 5n,          // the worker refuses to start new charges
  warnBelowRegistrations: 1000n, // the header warns, and registration closes
});

/**
 * level: 'ok' | 'WARNING' | 'CRITICAL'. registrationOpen is true only at 'ok':
 * registrations must never spend the gas that charges already owed will need.
 */
export async function readGasTank(client, executor) {
  const [balance, fees] = await Promise.all([client.getBalance({ address: executor }), client.estimateFeesPerGas()]);
  const costPerCharge = GAS_PER_CHARGE * fees.maxFeePerGas;
  const costPerRegistration = REGISTRATION_GAS * fees.maxFeePerGas + REGISTRATION_L1_FEE_WEI;
  const chargesRemaining = costPerCharge > 0n ? balance / costPerCharge : 0n;
  const registrationsRemaining = costPerRegistration > 0n ? balance / costPerRegistration : 0n;
  const L = GAS_TANK_LIMITS;
  const level = chargesRemaining < L.haltBelowCharges ? 'CRITICAL'
              : chargesRemaining < L.warnBelowCharges || registrationsRemaining < L.warnBelowRegistrations ? 'WARNING'
              : 'ok';
  return {
    level, executor, registrationOpen: level === 'ok',
    balanceEth: formatEther(balance),
    estimatedChargesRemaining: Number(chargesRemaining),
    estimatedRegistrationsRemaining: Number(registrationsRemaining),
    costPerChargeEth: formatEther(costPerCharge),
    costPerRegistrationEth: formatEther(costPerRegistration),
  };
}
