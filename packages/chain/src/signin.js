import { getAddress } from 'viem';

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
