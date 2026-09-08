/**
 * Deploy and prepare a scripted CoinbaseSmartWallet for the six-mode drills.
 *
 * A spend permission's `account` must be a Base Account (CoinbaseSmartWallet) --
 * the manager calls execute() on it -- so the generated test-user EOA cannot be
 * the payer directly. It can only be an OWNER of one.
 *
 * The real browser path (a genuine Base Account signing through the page) stays
 * in the definition of done. This exists so the state machine can be driven
 * deterministically and repeatedly without driving a browser thirty times.
 */
import { createPublicClient, createWalletClient, http, encodeAbiParameters, parseAbi, getAddress, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { erc20Abi } from '@retainer/chain';

const FACTORY = '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a';
const factoryAbi = parseAbi([
  'function createAccount(bytes[] owners, uint256 nonce) payable returns (address)',
  'function getAddress(bytes[] owners, uint256 nonce) view returns (address)',
]);
const walletAbi = parseAbi([
  'function addOwnerAddress(address owner)',
  'function isOwnerAddress(address account) view returns (bool)',
  'function replaySafeHash(bytes32 hash) view returns (bytes32)',
]);

const rpc = process.env.BASE_SEPOLIA_RPC_URL;
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const user = privateKeyToAccount(process.env.TEST_USER_PRIVATE_KEY);
const exec = privateKeyToAccount(process.env.EXECUTOR_PRIVATE_KEY);
const userW = createWalletClient({ account: user, chain: baseSepolia, transport: http(rpc) });
const execW = createWalletClient({ account: exec, chain: baseSepolia, transport: http(rpc) });
const MANAGER = getAddress(process.env.SPEND_PERMISSION_MANAGER);
const USDC = getAddress(process.env.USDC_ADDRESS);

const owners = [encodeAbiParameters([{ type: 'address' }], [user.address])];
const log = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

async function wait(hash, what) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${what} reverted: ${hash}`);
  return r;
}

const predicted = await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'getAddress', args: [owners, 0n] });

// 1. Give the test-user EOA a little gas so it can act as an owner.
const userEth = await pub.getBalance({ address: user.address });
if (userEth < 2_000_000_000_000_000n) {
  const h = await execW.sendTransaction({ to: user.address, value: 5_000_000_000_000_000n });
  await wait(h, 'fund test user');
  log({ step: 'funded test-user EOA for gas', tx: h });
}

// 2. Deploy the smart wallet if needed.
const code = await pub.getBytecode({ address: predicted });
if (!code) {
  const h = await userW.writeContract({ address: FACTORY, abi: factoryAbi, functionName: 'createAccount', args: [owners, 0n] });
  await wait(h, 'createAccount');
  log({ step: 'deployed CoinbaseSmartWallet', address: predicted, tx: h });
} else {
  log({ step: 'smart wallet already deployed', address: predicted });
}

// 3. The manager must be an owner, or it cannot execute() on the account.
//    Coinbase's own wallet does this during its approval flow; scripted wallets
//    must do it explicitly, exactly as upstream's Foundry tests do.
const managerIsOwner = await pub.readContract({ address: predicted, abi: walletAbi, functionName: 'isOwnerAddress', args: [MANAGER] });
if (!managerIsOwner) {
  const h = await userW.writeContract({ address: predicted, abi: walletAbi, functionName: 'addOwnerAddress', args: [MANAGER] });
  await wait(h, 'addOwnerAddress');
  log({ step: 'added SpendPermissionManager as wallet owner', tx: h });
} else {
  log({ step: 'manager already an owner' });
}

// 4. Move the faucet USDC from the EOA into the smart wallet, which is the
//    account the permission actually draws from.
const eoaUsdc = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [user.address] });
if (eoaUsdc > 0n) {
  const h = await userW.writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [predicted, eoaUsdc] });
  await wait(h, 'usdc transfer');
  log({ step: 'moved USDC into smart wallet', amount: eoaUsdc.toString(), tx: h });
}

log({
  ready: true,
  smartWallet: predicted,
  ownerEoa: user.address,
  walletUsdc: (await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [predicted] })).toString(),
  executorEth: formatEther(await pub.getBalance({ address: exec.address })),
});
