import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

export function config() {
  const chainId = Number(process.env.CHAIN_ID ?? 84532);
  if (chainId !== 84532) {
    // Phase 1 is testnet-only, and the disposable keys must never touch mainnet.
    throw new Error(`Retainer is Base Sepolia only. Refusing to run against chainId ${chainId}.`);
  }
  return {
    chainId,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org',
    manager: process.env.SPEND_PERMISSION_MANAGER,
    router: process.env.SPEND_ROUTER,
    usdc: process.env.USDC_ADDRESS,
    executor: process.env.EXECUTOR_ADDRESS,
    treasury: process.env.MERCHANT_TREASURY_ADDRESS,
  };
}

export function publicClient() {
  // Public RPCs throttle. Retry with backoff so one 429 does not fail a page
  // render or a worker tick; the alternative is a 500 that looks like a bug.
  return createPublicClient({
    chain: baseSepolia,
    transport: http(config().rpcUrl, { retryCount: 3, retryDelay: 400, timeout: 20_000 }),
  });
}

/** Wallet client for the executor. Signs locally; never used to hold funds. */
export function executorWallet() {
  const pk = process.env.EXECUTOR_PRIVATE_KEY;
  if (!pk) throw new Error('EXECUTOR_PRIVATE_KEY is not set');
  const account = privateKeyToAccount(pk);
  const cfg = config();
  if (cfg.executor && account.address.toLowerCase() !== cfg.executor.toLowerCase()) {
    throw new Error('EXECUTOR_PRIVATE_KEY does not match EXECUTOR_ADDRESS');
  }
  return createWalletClient({ account, chain: baseSepolia, transport: http(cfg.rpcUrl) });
}
