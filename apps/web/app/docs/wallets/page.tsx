import Link from "next/link";
import { H1, H2, P, UL, C, Cite, Callout, Table, Pre } from "@/components/docs/prose";

const SW = "https://github.com/coinbase/smart-wallet/blob/1bc2d0aa3b7dc6f73bf2029c848cfb88c1104901/src";
const SOLADY = "https://github.com/Vectorized/solady/blob/5ea5d9f57ed6d24a27d00934f4a3448def931415/src/utils";
const Up = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <Link href={href} target="_blank" rel="noopener noreferrer"
    className="ml-1 whitespace-nowrap rounded bg-neutral-500/10 px-1.5 py-0.5 align-baseline font-mono text-[11px] text-neutral-600 hover:underline dark:text-neutral-300">
    {children}
  </Link>
);

export default function Wallets() {
  return (
    <>
      <H1 lede="A customer does not need a Base Account. Any wallet that can sign typed data — MetaMask, Rabby, the Coinbase extension — can own a smart account that holds the spend permission. This page is how, and what it costs the customer.">
        Signing with any wallet
      </H1>

      <P>
        Coinbase&apos;s hosted consent screen refuses newly created Base Accounts on Base Sepolia, which until now meant nobody but the
        project&apos;s own scripted wallet could sign a permission on testnet. <Link href="/docs/limitations#363" className="text-brand-primary hover:underline">That is base/account-sdk#363</Link>.
        A wallet-owned smart account never reaches that screen.
      </P>

      <H2 id="shape">The shape: the wallet owns the account, it is not the account</H2>
      <P>
        A spend permission&apos;s <C>account</C> must be a <C>CoinbaseSmartWallet</C>, because the manager moves money by calling
        <C>execute()</C> on it. An ordinary wallet address cannot be that account — but it can <i>own</i> one. So the customer&apos;s wallet
        address is made the first owner of a smart account created for it, and the SpendPermissionManager the second.
        <Cite file="packages/chain/src/smart-account.js" line={48} />
      </P>
      <UL>
        <li><b>The address is known before the account exists.</b> It is derived from the owners and nonce 0, so one wallet always maps to one smart account, which can be shown to the customer and funded before anything is deployed. <Cite file="packages/chain/src/smart-account.js" line={22} /></li>
        <li><b>The manager is an owner from creation.</b> Without it every charge reverts, because <C>execute()</C> only accepts an owner. Naming it in the initial owners removes the extra transaction the Phase 1 setup script needed. The drill proves both halves: the manager is an owner of the freshly created account, and the charge settles. <Cite file="scripts/phase3-drills.mjs" line={162} /></li>
      </UL>

      <H2 id="signature">What the wallet actually signs</H2>
      <P>
        MetaMask will not sign a raw 32-byte hash, and it does not have to. The account validates a signature over its own
        <C>replaySafeHash(hash)</C>, which is the EIP-712 digest of <C>CoinbaseSmartWalletMessage&#123;hash&#125;</C> under the
        account&apos;s domain — so ordinary <C>eth_signTypedData_v4</C> produces exactly what it checks.
        <Cite file="packages/chain/src/smart-account.js" line={74} />
        <Up href={`${SW}/ERC1271.sol#L69`}>smart-wallet ERC1271.sol:69</Up>
      </P>
      <Pre title="what the customer's wallet is asked to sign">{`domain       "Coinbase Smart Wallet", version 1, chain 84532, verifyingContract = their smart account
primaryType  CoinbaseSmartWalletMessage
message      { hash: <the permission's hash, from SpendPermissionManager.getHash> }`}</Pre>

      <H2 id="one-signature">One signature, no separate deployment</H2>
      <P>
        The customer signs before their account exists. The server wraps the signature in ERC-6492 — the factory, the
        <C>createAccount</C> call, and the signature — and submits it to <C>approveWithSignature</C>, which the executor already pays
        for. The manager&apos;s validator creates the account, then checks the signature, then approves the permission, in one
        transaction. <Cite file="packages/chain/src/smart-account.js" line={106} /> <Cite file="contracts/src/SpendPermissionManager.sol" line={299} />
      </P>
      <P>
        The server always sends the wrapped form. For a returning customer whose account already exists, the validator tries the inner
        signature first and skips the deployment. One path, new or returning. <Cite file="apps/web/app/api/permissions/route.js" line={138} />
      </P>

      <H2 id="7702">EIP-7702 accounts are detected before anyone signs</H2>
      <P>
        The signature check uses plain <C>ecrecover</C> only when the owner has <i>no code</i>. A wallet that has been upgraded under
        EIP-7702 has code — a delegation designator — so its signatures are judged by its delegate contract instead, and whether that
        contract accepts this message has not been verified.
        <Up href={`${SOLADY}/SignatureCheckerLib.sol#L30`}>solady SignatureCheckerLib.sol:30</Up>
      </P>
      <P>
        So the owner&apos;s code is read from the chain the moment the wallet connects, and a 7702 account is told plainly instead of being
        asked to sign into a failure. <Cite file="apps/web/components/sign/sign-flow.tsx" line={166} /> The server checks again before
        doing anything that costs gas. <Cite file="apps/web/app/api/permissions/route.js" line={109} /> This is the specific thing the
        hosted flow gets wrong: its capability check reports the chain as supported, and the popup then refuses. Here the answer comes
        from the chain, not from the wallet&apos;s description of itself. <Cite file="packages/chain/src/smart-account.js" line={119} />
      </P>
      <Callout kind="note" title="An upgrade after approval changes nothing">
        Spending checks the stored approval, not the signature: <C>spend</C> requires only that the permission is approved and not revoked.
        <Cite file="contracts/src/SpendPermissionManager.sol" line={496} /> <Cite file="contracts/src/SpendPermissionManager.sol" line={695} /> The
        drill demonstrates it on-chain — it upgrades the owner to a 7702 account after approval and simulates a spend at that block,
        which still validates. <Cite file="scripts/phase3-drills.mjs" line={248} />
      </Callout>

      <H2 id="consent">The consent screen is the whole consent</H2>
      <P>
        Coinbase&apos;s screen shows the terms. MetaMask shows an opaque hash. So on this path the customer&apos;s understanding rests entirely
        on the sign page, and it is built around that:
      </P>
      <UL>
        <li>The terms come first, before any wallet is connected: token, exact cap, period, start, expiry, who collects, where it goes, and how to stop it.</li>
        <li>Every figure is rendered from the exact struct that gets hashed and signed.</li>
        <li>The sign button stays disabled until the hash computed on the page equals the manager&apos;s own <C>getHash</C>, read from the chain. <Cite file="apps/web/components/sign/sign-flow.tsx" line={296} /> <Cite file="apps/web/components/sign/sign-flow.tsx" line={298} /></li>
        <li>That same hash is shown as the fingerprint the wallet will display, with an instruction not to sign if it differs — which turns a blind signature into one the customer can check. <Cite file="apps/web/components/sign/sign-flow.tsx" line={401} /></li>
        <li>The server recomputes the hash itself and refuses a mismatch, so a page that showed one thing and submitted another is caught. <Cite file="apps/web/app/api/permissions/route.js" line={85} /></li>
      </UL>

      <H2 id="funding">Funding: the real cost of this path</H2>
      <P>
        Charges draw from the smart account, not from the customer&apos;s wallet address, and it starts empty. A customer has to move USDC
        into an address they had never seen a minute earlier. The sign page makes this its own step, with the live balance, a one-click
        transfer from the connected wallet, and an explicit acknowledgement if they choose to sign first.
        <Cite file="apps/web/components/sign/sign-flow.tsx" line={362} />
      </P>
      <Callout kind="warn" title="Not yet built: funding with a signature alone">
        USDC supports EIP-3009: the customer signs one more typed-data message authorising a transfer from their wallet to their smart
        account, and Retainer submits it and pays the gas. The customer would need no ETH at all. This has been <i>simulated</i> against
        Base Sepolia USDC — the authorised transfer moves the funds, and the same authorisation signed by any other key is refused — but it
        is not built, and nothing here depends on it.
      </Callout>

      <H2 id="refusals">What the server refuses, and why</H2>
      <P>
        Every refusal is sent before a transaction is built, and the drill asserts each one three ways: the right reason, no executor
        transaction, no row written. <Cite file="scripts/phase3-drills.mjs" line={130} />
      </P>
      <Table head={["Refusal", "What it catches"]} rows={[
        [<C key="a">wrong_domain</C>, <>Typed data signed under the wrong domain version. <Cite key="a1" file="apps/web/app/api/permissions/route.js" line={131} /></>],
        [<C key="b">personal_sign</C>, <>The hash signed as a plain message rather than typed data. <Cite key="b1" file="apps/web/app/api/permissions/route.js" line={127} /></>],
        [<C key="c">unwrapped_hash</C>, <>The bare permission hash, without the account&apos;s replay-safe wrapper — which would be valid for any account. <Cite key="c1" file="apps/web/app/api/permissions/route.js" line={129} /></>],
        [<C key="d">not_owner</C>, <>Correctly formed typed data from a key that does not own the account. <Cite key="d1" file="apps/web/app/api/permissions/route.js" line={122} /></>],
        [<C key="e">account_mismatch</C>, <>A permission for a smart account the signer does not own. <Cite key="e1" file="apps/web/app/api/permissions/route.js" line={100} /></>],
        [<C key="f">eip7702</C>, <>An owner upgraded under EIP-7702, as above. <Cite key="f1" file="scripts/phase3-drills.mjs" line={250} /></>],
        [<C key="g">contract_owner</C>, <>A contract as the owner — a Safe cannot own this account, and pays by transfer instead. <Cite key="g1" file="scripts/phase3-drills.mjs" line={150} /></>],
        [<C key="h">policy</C>, <>Any term other than the configured allowance, period, expiry, start window, spender or token. <Cite key="h1" file="apps/web/app/api/permissions/policy.js" line={52} /></>],
        [<C key="i">rate_limited</C>, <>A second registration from one signer inside the cooldown, or too many from one client or overall. <Cite key="i1" file="apps/web/app/api/permissions/route.js" line={156} /></>],
      ]} />
      <P>
        Before this path existed the server checked only the spender and the routing, so a caller could make the executor pay to register
        any allowance, period or expiry. Every term is now pinned to configuration, and the transaction is simulated before it is sent.
        <Cite file="apps/web/app/api/permissions/policy.js" line={26} /> <Cite file="apps/web/app/api/permissions/route.js" line={173} />
      </P>

      <H2 id="revoke">Revoking</H2>
      <P>
        The manager accepts <C>revoke</C> only from the account itself. <Cite file="contracts/src/SpendPermissionManager.sol" line={397} /> The
        account accepts <C>execute</C> from its owner, so the customer&apos;s wallet sends one transaction:
        <C>account.execute(manager, revoke(permission))</C>. <Cite file="apps/web/components/sign/sign-flow.tsx" line={257} /> It costs a
        little testnet ETH — the one step on this path the customer pays for. The drill sends exactly that from the customer&apos;s own key and
        confirms the permission is revoked on-chain. <Cite file="scripts/phase3-drills.mjs" line={258} />
      </P>
      <P>
        Nothing indexes the revocation event, and a customer&apos;s revoke never passes through our server, so the page reports it afterwards.
        The record is written only if that transaction succeeded, contains the manager&apos;s revocation event for exactly this permission,
        and the manager reports it revoked now. <Cite file="apps/web/app/api/permissions/revoke/route.js" line={42} />
      </P>

      <H2 id="record">How it is recorded</H2>
      <P>
        Each permission records how it was signed — <C>base_account</C> or <C>eoa_owned</C> — and, for the second, which wallet owns the
        account. Permissions created before this was recorded keep an empty value rather than a guess.
        <Cite file="packages/db/migrations/004_signing_path.sql" line={15} /> <Cite file="packages/db/migrations/004_signing_path.sql" line={26} />
      </P>

      <H2 id="unproven">Not yet proven</H2>
      <UL>
        <li><b>The real MetaMask client.</b> Everything above is proven through the endpoint with a key that signs exactly what the page asks for. What MetaMask itself displays, and whether it warns about or refuses this typed data, is answered only by a live session.</li>
        <li><b>A stranger, on the public site.</b> Registration needs the executor key, which is deliberately not deployed, and there is no hosted worker to run charges. Both are one pending, deliberate step.</li>
        <li><b>Mainnet.</b> The one-signature path depends on Solady&apos;s ERC-6492 verifier being deployed on the chain. It is on Base Sepolia; mainnet has not been checked.</li>
      </UL>
    </>
  );
}
