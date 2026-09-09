/**
 * Fund two real senders on Base Sepolia so the matching drills run end to end
 * against indexed on-chain transfers rather than rows inserted by hand.
 *
 *   SENDER_A -- the test-user EOA, linked to customer 1 (a "known sender")
 *   SENDER_B -- a fresh EOA, deliberately NOT linked (an "unknown sender")
 *
 * USDC is drawn out of the scripted smart wallet, which holds the faucet
 * balance, by calling execute() on it as its owner.
 *
 * Prints addresses only. Never a private key.
 */
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, getAddress, formatEther } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { appendFileSync, readFileSync } from 'node:fs';
import { erc20Abi } from '@retainer/chain';

const rpc = process.env.BASE_SEPOLIA_RPC_URL;
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const USDC = getAddress(process.env.USDC_ADDRESS);
const WALLET = getAddress(process.env.TEST_SMART_WALLET);

const owner = privateKeyToAccount(process.env.TEST_USER_PRIVATE_KEY);
const exec = privateKeyToAccount(process.env.EXECUTOR_PRIVATE_KEY);
const ownerW = createWalletClient({ account: owner, chain: baseSepolia, transport: http(rpc) });
const execW = createWalletClient({ account: exec, chain: baseSepolia, transport: http(rpc) });
const walletAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);

const log = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
const bal = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
async function wait(hash, what) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${what} reverted: ${hash}`);
  return r;
}

// --- SENDER_B: fresh, unlinked. Persisted so drills are re-runnable. ---
let bKey = process.env.TEST_SENDER_B_PRIVATE_KEY;
if (!bKey) {
  bKey = generatePrivateKey();
  const envPath = new URL('../.env', import.meta.url).pathname;
  const b = privateKeyToAccount(bKey);
  if (!readFileSync(envPath, 'utf8').includes('TEST_SENDER_B_ADDRESS')) {
    appendFileSync(envPath,
      `\n# Phase 2 drills: a second sender, deliberately NOT linked to any customer.\n` +
      `TEST_SENDER_B_ADDRESS=${b.address}\nTEST_SENDER_B_PRIVATE_KEY=${bKey}\n`);
  }
  log({ step: 'generated SENDER_B (written to .env, key not printed)', address: b.address });
}
const senderB = privateKeyToAccount(bKey);
const bW = createWalletClient({ account: senderB, chain: baseSepolia, transport: http(rpc) });

// --- gas for both senders ---
for (const [label, addr] of [['SENDER_A', owner.address], ['SENDER_B', senderB.address]]) {
  const eth = await pub.getBalance({ address: addr });
  if (eth < 3_000_000_000_000_000n) {
    const h = await execW.sendTransaction({ to: addr, value: 5_000_000_000_000_000n });
    await wait(h, `fund ${label}`);
    log({ step: `funded ${label} with gas`, address: addr, tx: h });
  }
}

// --- draw USDC out of the smart wallet to SENDER_A ---
const want = 5_000_000n; // 5 USDC is plenty for many sub-dollar drills
if ((await bal(owner.address)) < want) {
  const walletUsdc = await bal(WALLET);
  const move = walletUsdc < want ? walletUsdc : want;
  if (move > 0n) {
    const h = await ownerW.writeContract({
      address: WALLET, abi: walletAbi, functionName: 'execute',
      args: [USDC, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner.address, move] })],
    });
    await wait(h, 'smart wallet -> SENDER_A');
    log({ step: 'moved USDC out of the smart wallet to SENDER_A', amount: move, tx: h });
  }
}

// --- give SENDER_B some USDC so it can pay too ---
if ((await bal(senderB.address)) < 1_000_000n) {
  const h = await createWalletClient({ account: owner, chain: baseSepolia, transport: http(rpc) })
    .writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [senderB.address, 1_500_000n] });
  await wait(h, 'SENDER_A -> SENDER_B');
  log({ step: 'funded SENDER_B with USDC', amount: '1500000', tx: h });
}

log({
  ready: true,
  SENDER_A: { address: owner.address, usdc: (await bal(owner.address)).toString(), role: 'known sender (link to a customer)' },
  SENDER_B: { address: senderB.address, usdc: (await bal(senderB.address)).toString(), role: 'unknown sender (never linked)' },
  smartWallet: { address: WALLET, usdc: (await bal(WALLET)).toString() },
  treasury: process.env.MERCHANT_TREASURY_ADDRESS,
  executorEth: formatEther(await pub.getBalance({ address: exec.address })),
});
