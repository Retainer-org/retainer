// Exercise the classifier against real chain state, no database involved.
import { classify, config, publicClient, encodeExtraData } from '@retainer/chain';
const cfg = config(); const client = publicClient();
const now = Math.floor(Date.now() / 1000);
const WALLET = process.env.TEST_SMART_WALLET;
const base = {
  account: WALLET, spender: cfg.router, token: cfg.usdc,
  allowance: 5000000n, period: 3600, salt: 424242n,
  extraData: encodeExtraData(cfg.executor, cfg.treasury),
  executor: cfg.executor, recipient: cfg.treasury,
};
const cases = [
  ['unregistered permission',        { ...base, start: now,        end: now + 86400 }, 1000000n],
  ['window already closed',          { ...base, start: now - 7200, end: now - 3600 }, 1000000n],
  ['window not yet open',            { ...base, start: now + 3600, end: now + 86400 }, 1000000n],
  ['amount above the period cap',    { ...base, start: now,        end: now + 86400 }, 9000000n],
];
for (const [label, permission, amount] of cases) {
  const v = await classify({ client, permission, amount, manager: cfg.manager, router: cfg.router });
  console.log(`  ${label.padEnd(30)} -> ${v.ok ? 'OK' : v.mode}  ${v.ok ? '' : '(' + v.detail + ')'}`);
}
console.log('\n  wallet USDC balance:',
  (await client.readContract({ address: cfg.usdc, abi: (await import('@retainer/chain')).erc20Abi,
    functionName: 'balanceOf', args: [WALLET] })).toString());
