import { H1, H2, H3, P, UL, C, Cite, Callout, Pre, Table } from "@/components/docs/prose";

export default function SpendPermissions() {
  return (
    <>
      <H1 lede="The primitive Retainer is built on. Most readers won't have met it, so this page explains it properly.">Spend permissions</H1>

      <P>
        A spend permission is a signed message from a Base Account that lets a named <i>spender</i> pull a named <i>token</i> from the
        account, up to an <i>allowance</i> per <i>period</i>, between a <i>start</i> and an <i>end</i>. Coinbase&apos;s
        <C>SpendPermissionManager</C> contract enforces every one of those bounds; the spender cannot exceed them, and Retainer does not
        need to be trusted to respect them. <Cite file="contracts/src/SpendPermissionManager.sol" line={28} />
      </P>

      <H2 id="struct">What the customer signs</H2>
      <Pre title="SpendPermissionManager.sol — the struct, verbatim">{`struct SpendPermission {
    address account;    // the customer's Base Account
    address spender;    // who may pull: Retainer's router
    address token;      // USDC
    uint160 allowance;  // maximum per period
    uint48  period;     // seconds; the allowance resets on this cadence
    uint48  start;      // valid from (inclusive)
    uint48  end;        // valid until (exclusive)
    uint256 salt;       // makes otherwise-identical permissions distinct
    bytes   extraData;  // consumed by the spender: for the router, (executor, recipient)
}`}</Pre>

      <H2 id="properties">The five properties that matter</H2>
      <Table head={["Property", "What it means", "Where the contract does it"]} rows={[
        ["Bounded per period", <>The spender can pull any amount, in any number of transactions, until the period&apos;s total reaches <C>allowance</C>. The next pull reverts with <C>ExceededSpendPermission</C>.</>, <Cite file="contracts/src/SpendPermissionManager.sol" line={690} label="_useSpendPermission" />],
        ["Self-resetting", <>Periods are fixed intervals from <C>start</C>. When time enters a new period the used amount resets to zero. <b>Unused allowance does not carry forward.</b></>, <Cite file="contracts/src/SpendPermissionManager.sol" line={516} label="getCurrentPeriod" />],
        ["Revocable", <>The customer calls <C>revoke</C>; the spender can also call <C>revokeAsSpender</C>. It takes effect in the block it is mined, and it is permanent — there is no un-revoke.</>, <Cite file="contracts/src/SpendPermissionManager.sol" line={397} />],
        ["Expiring", <><C>end</C> is a hard stop. Pulls after it revert with <C>AfterSpendPermissionEnd</C>; pulls before <C>start</C> revert with <C>BeforeSpendPermissionStart</C>.</>, <Cite file="contracts/src/SpendPermissionManager.sol" line={516} />],
        ["Enforced on-chain", <>All of the above is contract logic. Retainer holds a key that can <i>ask</i>; the manager decides.</>, <Cite file="contracts/src/SpendPermissionManager.sol" line={420} label="spend" />],
      ]} />

      <H3 id="reset">How the reset actually works</H3>
      <P>
        From Coinbase&apos;s own accounting note, at the commit Retainer vendors: <i>&ldquo;As apps spend user assets, the recurring logic
        automatically increments and enforces the allowance for the current period. Once enough time passes to enter the next period, the
        allowance usage is reset to zero and the app can keep spending up to the same allowance.&rdquo;</i> The start time and period
        &ldquo;set a deterministic schedule infinitely into the future&rdquo;; the end time &ldquo;does not have to correlate with a clean
        period boundary.&rdquo;
        <Cite file="contracts/src/PROVENANCE.md" label="upstream docs/SpendPermissionAccounting.md @ e0004e6" />
      </P>

      <H2 id="registration">Registration is permissionless — so the customer never pays gas</H2>
      <P>
        Signing is off-chain. The permission becomes usable when someone submits <C>approveWithSignature(permission, signature)</C>, and
        that function has no caller restriction: anyone holding a valid signature can submit it, and it is ERC-6492-compatible, so it
        works even if the customer&apos;s account is not yet deployed. Retainer&apos;s executor submits it and pays.
        <Cite file="contracts/src/SpendPermissionManager.sol" line={293} />
      </P>

      <H2 id="cap">What the cap does to billing</H2>
      <P>
        This is the constraint the rest of Retainer is shaped around. The allowance is a ceiling the customer sets <i>before</i> the charge
        amount is known. A metered bill above the cap cannot be collected, and there is no <C>increaseAllowance</C>: raising the cap means
        a new permission and a new signature. A charge that fails because the cap is exhausted is not retried until the next period,
        because retrying sooner cannot succeed. <Cite file="packages/chain/src/classify.js" line={53} />
      </P>

      <Callout title="What a failed pull costs">
        A reverted <C>spend</C> rolls back the accounting in the same transaction, so a failed charge consumes no allowance. It does
        consume gas. Retainer therefore checks chain state before broadcasting and almost never sends a transaction it expects to revert.
        <Cite file="contracts/test/retainer/RouterCustodyInvariant.t.sol" line={72} />
      </Callout>

      <H2 id="account">The account must be a Base Account</H2>
      <P>
        The manager moves funds by calling <C>execute()</C> on the customer&apos;s account, so the account must be a smart account that
        lists the manager as an owner. A plain externally-owned wallet cannot be the payer. Coinbase&apos;s wallet adds the manager as an
        owner inside its approval flow; a scripted account has to do it explicitly, and if it doesn&apos;t, every charge reverts.
        <Cite file="README.md" line={172} label="README — the non-obvious prerequisite" />
      </P>
      <UL>
        <li>Manager, canonical on Base and Base Sepolia: <C>0xf85210B21cC50302F477BA56686d2019dC9b67Ad</C></li>
        <li>Its on-chain EIP-712 typehash equals <C>keccak256</C> of the type string in the vendored source, so the code Retainer reads is the code it transacts against. <Cite file="contracts/test/retainer/ErrorSelectors.t.sol" label="test_typehash_matchesDeployedManager" /></li>
      </UL>
    </>
  );
}
