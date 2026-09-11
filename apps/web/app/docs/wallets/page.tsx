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
        signature first and skips the deployment. One path, new or returning. <Cite file="apps/web/app/api/permissions/route.js" line={156} />
      </P>

      <H2 id="7702">EIP-7702 accounts are detected before anyone signs</H2>
      <P>
        The signature check uses plain <C>ecrecover</C> only when the owner has <i>no code</i>. A wallet that has been upgraded under
        EIP-7702 has code — a delegation designator — so its signatures are judged by its delegate contract instead, and whether that
        contract accepts this message has not been verified.
        <Up href={`${SOLADY}/SignatureCheckerLib.sol#L30`}>solady SignatureCheckerLib.sol:30</Up>
      </P>
      <P>
        So the owner&apos;s code is read from the chain the moment the wallet connects, and a 7702 account delegating to anything but the one
        verified delegator below is told plainly instead of being asked to sign into a failure. <Cite file="apps/web/components/sign/sign-flow.tsx" line={184} /> The server checks again before
        doing anything that costs gas. <Cite file="apps/web/app/api/permissions/route.js" line={123} /> This is the specific thing the
        hosted flow gets wrong: its capability check reports the chain as supported, and the popup then refuses. Here the answer comes
        from the chain, not from the wallet&apos;s description of itself. <Cite file="packages/chain/src/smart-account.js" line={120} />
      </P>
      <Callout kind="note" title="An upgrade after approval changes nothing">
        Spending checks the stored approval, not the signature: <C>spend</C> requires only that the permission is approved and not revoked.
        <Cite file="contracts/src/SpendPermissionManager.sol" line={496} /> <Cite file="contracts/src/SpendPermissionManager.sol" line={695} /> The
        drill demonstrates it on-chain — it upgrades the owner to a 7702 account after approval and simulates a spend at that block,
        which still validates. <Cite file="scripts/phase3-drills.mjs" line={248} />
      </Callout>

      <H2 id="metamask-upgrades">MetaMask upgrades accounts by itself</H2>
      <P>
        In the first live session MetaMask converted both customer accounts to EIP-7702 accounts without this page asking it to. Each time it
        happened inside a revoke: MetaMask sent the revoke through its own relayer and its <C>DelegationManager</C>, carrying an authorisation that
        delegated the account to its <C>EIP7702StatelessDeleGator</C> in the same transaction. <Cite tx="0x2b19810bc90818b1a1baf0f6690aed03b1c3138cc0e218961b6f9d2b409b7a55" /> <Cite tx="0x48c02895cd37c435c38cd73219b7ba892c53ed5d9504fb978abcb0e151075d20" />
      </P>
      <P>
        Existing permissions are unaffected, since spending checks the stored approval, and the page still lists them and lets the customer revoke them
        whatever their account has become. <Cite file="apps/web/components/sign/sign-flow.tsx" line={185} /> A new registration from an upgraded account was
        refused at first, because its signatures are judged by the delegate — which is what the exception below resolves.
      </P>
      <P>
        MetaMask also connects whichever account is selected in it, so a returning customer can arrive as a different account without noticing. The page
        shows the connected account prominently and says when it differs from one that registered earlier in the same browser session
        <Cite file="apps/web/components/sign/sign-flow.tsx" line={436} />; re-runs every check when the wallet reports a different account, so a refusal for
        one account never lingers for another <Cite file="apps/web/components/sign/sign-flow.tsx" line={236} />; and offers MetaMask&apos;s own account picker
        from the refusal <Cite file="apps/web/components/sign/sign-flow.tsx" line={249} />. That behaviour is checked in a browser, with a negative control
        run against the previous page. <Cite file="scripts/check-sign-ui.mjs" line={95} />
      </P>
      <Callout kind="note" title="A deliberate, scoped exception: MetaMask's delegator">
        One EIP-7702 delegate is accepted as an owner: MetaMask&apos;s <C>EIP7702StatelessDeleGator</C>, by its single address, hardcoded with the
        reasoning beside it. <Cite file="packages/chain/src/smart-account.js" line={153} /> Its verified source checks a signature with
        <C>ECDSA.recover(hash, signature) == address(this)</C> — a plain signature by the account&apos;s own key, with no wrapping of its own — so
        the security property is the same as a plain account&apos;s, which is what the rest of this flow already relies on.
        <Cite file="packages/chain/src/smart-account.js" line={136} /> It was tested before it was trusted: a key delegated to it
        registers, and the same message signed by any other key is refused. <Cite tx="0x930de800f78638f8f2457e5b5b0d182f44fb73807da704d56f83f39a97fdebe2" />
        <br /><br />
        The trust is pinned to code, not just to the address. Every check hashes the code deployed at that address and compares it with the
        version that was reviewed; if they differ, the owner is refused. <Cite file="packages/chain/src/smart-account.js" line={156} />
        <Cite file="packages/chain/src/smart-account.js" line={180} /> Every other delegate is still refused, and so is every contract account that is not a
        7702 delegation. <Cite file="packages/chain/src/smart-account.js" line={176} /> The server applies the same decision before any gas.
        <Cite file="apps/web/app/api/permissions/route.js" line={123} />
        <br /><br />
        The drill keeps all of it honest on every run: an owner delegated to MetaMask&apos;s delegator registers
        <Cite file="scripts/phase3-drills.mjs" line={291} />, a different key&apos;s signature for that account is refused
        <Cite file="scripts/phase3-drills.mjs" line={288} />, the same address with a different code hash is refused
        <Cite file="scripts/phase3-drills.mjs" line={300} />, and an owner delegating to any other contract is refused outright
        <Cite file="scripts/phase3-drills.mjs" line={250} />. It was first exercised end to end on-chain here. <Cite tx="0xbb7dd1d27ebcc5ab8c72670f359609e6d45ba438be5516058bd6e0cc3ff6eb07" />
      </Callout>

      <H2 id="consent">The consent screen is the whole consent</H2>
      <P>
        Coinbase&apos;s screen shows the terms. MetaMask shows an opaque hash. So on this path the customer&apos;s understanding rests entirely
        on the sign page, and it is built around that:
      </P>
      <UL>
        <li>The terms come first, before any wallet is connected: token, exact cap, period, start, expiry, who collects, where it goes, and how to stop it.</li>
        <li>Every figure is rendered from the exact struct that gets hashed and signed.</li>
        <li>The sign button stays disabled until the hash computed on the page equals the manager&apos;s own <C>getHash</C>, read from the chain. <Cite file="apps/web/components/sign/sign-flow.tsx" line={370} /> <Cite file="apps/web/components/sign/sign-flow.tsx" line={372} /></li>
        <li>That same hash is shown as the fingerprint the wallet will display, with an instruction not to sign if it differs — which turns a blind signature into one the customer can check. <Cite file="apps/web/components/sign/sign-flow.tsx" line={530} /></li>
        <li>The server recomputes the hash itself and refuses a mismatch, so a page that showed one thing and submitted another is caught. <Cite file="apps/web/app/api/permissions/route.js" line={99} /></li>
      </UL>

      <H2 id="funding">Funding: the real cost of this path</H2>
      <P>
        Charges draw from the smart account, not from the customer&apos;s wallet address, and it starts empty. A customer has to move USDC
        into an address they had never seen a minute earlier. The sign page makes this its own step, with the live balance, a one-click
        transfer from the connected wallet, and an explicit acknowledgement if they choose to sign first. Whatever is in the account can be withdrawn to the owner&apos;s wallet
        from the same step. <Cite file="apps/web/components/sign/sign-flow.tsx" line={277} />
        <Cite file="apps/web/components/sign/sign-flow.tsx" line={485} />
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
        [<C key="a">wrong_domain</C>, <>Typed data signed under the wrong domain version. <Cite key="a1" file="apps/web/app/api/permissions/route.js" line={149} /></>],
        [<C key="b">personal_sign</C>, <>The hash signed as a plain message rather than typed data. <Cite key="b1" file="apps/web/app/api/permissions/route.js" line={145} /></>],
        [<C key="c">unwrapped_hash</C>, <>The bare permission hash, without the account&apos;s replay-safe wrapper — which would be valid for any account. <Cite key="c1" file="apps/web/app/api/permissions/route.js" line={147} /></>],
        [<C key="d">not_owner</C>, <>Correctly formed typed data from a key that does not own the account. <Cite key="d1" file="apps/web/app/api/permissions/route.js" line={140} /></>],
        [<C key="e">account_mismatch</C>, <>A permission for a smart account the signer does not own. <Cite key="e1" file="apps/web/app/api/permissions/route.js" line={114} /></>],
        [<C key="f">eip7702</C>, <>An owner upgraded under EIP-7702, as above. <Cite key="f1" file="scripts/phase3-drills.mjs" line={250} /></>],
        [<C key="g">contract_owner</C>, <>A contract as the owner — a Safe cannot own this account, and pays by transfer instead. <Cite key="g1" file="scripts/phase3-drills.mjs" line={150} /></>],
        [<C key="h">policy</C>, <>Any term other than the configured allowance, period, expiry, start window, spender or token. <Cite key="h1" file="apps/web/app/api/permissions/policy.js" line={52} /></>],
        [<C key="i">rate_limited</C>, <>A second registration from one signer inside the cooldown, or too many from one client or overall. <Cite key="i1" file="apps/web/app/api/permissions/route.js" line={174} /></>],
      ]} />
      <P>
        Before this path existed the server checked only the spender and the routing, so a caller could make the executor pay to register
        any allowance, period or expiry. Every term is now pinned to configuration, and the transaction is simulated before it is sent.
        <Cite file="apps/web/app/api/permissions/policy.js" line={26} /> <Cite file="apps/web/app/api/permissions/route.js" line={191} />
      </P>

      <H2 id="revoke">Revoking</H2>
      <P>
        The manager accepts <C>revoke</C> only from the account itself. <Cite file="contracts/src/SpendPermissionManager.sol" line={397} /> The
        account accepts <C>execute</C> from its owner, so the page asks the customer&apos;s wallet for one call:
        <C>account.execute(manager, revoke(permission))</C>. <Cite file="apps/web/components/sign/sign-flow.tsx" line={326} /> The drill sends
        exactly that from the customer&apos;s own key and confirms the permission is revoked on-chain. <Cite file="scripts/phase3-drills.mjs" line={258} /> In
        the live session MetaMask submitted the same call through its own relayer instead, and upgraded the account in the same transaction; the
        revocation landed all the same. <Cite tx="0x2b19810bc90818b1a1baf0f6690aed03b1c3138cc0e218961b6f9d2b409b7a55" />
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
        <li><b>What MetaMask displays around the signature.</b> Signing with the real MetaMask client is proven: permission #18 was registered from a MetaMask account <Cite tx="0xa647cbb0f762f9ea7d4fe7eaef576021f4564840f5d4c0b9cd27e6dc142bf34b" />, and the fingerprint on the page matched the hash MetaMask showed. What else MetaMask displayed — including any security warning — is being recorded from that session and is not written up here yet.</li>
        <li><b>A stranger, on the public site.</b> Registration needs the executor key, which is deliberately not deployed, and there is no hosted worker to run charges. Both are one pending, deliberate step. Until then the page says so before anyone signs. <Cite file="apps/web/components/sign/sign-flow.tsx" line={396} /></li>
        <li><b>Mainnet.</b> The one-signature path depends on Solady&apos;s ERC-6492 verifier being deployed on the chain. It is on Base Sepolia; mainnet has not been checked.</li>
      </UL>
    </>
  );
}
