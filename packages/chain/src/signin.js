import { getAddress } from 'viem';
import { classifyOwnerCode } from './smart-account.js';

/**
 * Sign-in: proving a wallet is yours, so the site serves you your own permissions and no one else's.
 *
 * Built to be unmistakable for anything that authorises money: its own domain name, no
 * verifying contract, its own primary type, and a statement that says it authorises nothing.
 * A wallet shows it as "Retainer Sign-In" -- never as "Coinbase Smart Wallet" or as the
 * permission manager, the two domains a customer signs when they grant a permission.
 *
 * Shared by the page (which asks the wallet to sign it) and the server (which rebuilds it
 * from its own stored nonce and checks the signature), so the two cannot drift apart.
 *
 * What it proves is narrow: this address is controlled by whoever is at the keyboard. It
 * stops Retainer serving one customer's permissions to another. It does not make anything
 * private -- permissions and charges are on a public chain.
 */
export const SIGNIN_DOMAIN_NAME = 'Retainer Sign-In';
export const SIGNIN_STATEMENT =
  'Sign in to see your Retainer permissions. This costs nothing, sends no transaction and authorises no payment.';

export const SIGNIN_TYPES = {
  RetainerSignIn: [
    { name: 'account', type: 'address' },
    { name: 'statement', type: 'string' },
    { name: 'origin', type: 'string' },
    { name: 'nonce', type: 'string' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
};

/**
 * Who may sign in: whoever holds the key to the address. Deliberately NOT checkOwner.
 *
 * Sign-in and registration ask different questions, so they use different rules. Do not
 * unify them.
 *
 *   Sign-in asks one thing: does the person at the keyboard hold this wallet's key? That is
 *   answered directly -- plain ECDSA recovery of the signature against the address, done by
 *   the caller. EIP-7702 delegation adds code to an account without taking the key away, so
 *   this holds for a plain account and for EVERY upgraded account, whatever its delegate. The
 *   delegate is never consulted and never trusted, and ERC-1271 is never used: an
 *   unreviewed contract has no say in whether someone may see their own records.
 *
 *   Registration (checkOwner, in smart-account.js) asks something else: will the customer's
 *   smart account, on-chain, accept signatures from this owner? There the owner's code IS the
 *   signature checker, so its delegate must be one we reviewed -- which is why exactly one
 *   MetaMask delegate is pinned there, and nowhere else. Getting it wrong there creates a
 *   permission that moves money; getting sign-in right needs only the key.
 *
 * The one refusal: a true contract account (code that is not a 7702 delegation) has no key to
 * sign with. It cannot register a permission either, so there is nothing for it to see.
 */
export async function signInKeyHolder(client, address) {
  const k = classifyOwnerCode(await client.getCode({ address }));
  if (k.kind === 'contract') return { accepted: false, kind: 'contract', reason: 'contract_account' };
  return { accepted: true, kind: k.kind };   // 'eoa' | 'eip7702' -- which delegate is irrelevant here
}

export function signInTypedData({ chainId, account, origin, nonce, issuedAt, expiresAt }) {
  return {
    domain: { name: SIGNIN_DOMAIN_NAME, version: '1', chainId: Number(chainId) },
    types: SIGNIN_TYPES,
    primaryType: 'RetainerSignIn',
    message: {
      account: getAddress(account), statement: SIGNIN_STATEMENT, origin, nonce,
      issuedAt: BigInt(issuedAt), expiresAt: BigInt(expiresAt),
    },
  };
}
