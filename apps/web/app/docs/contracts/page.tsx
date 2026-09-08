import { H1, H2, P, UL, C, Cite, Callout, Table, Addr } from "@/components/docs/prose";

export default function Contracts() {
  return (
    <>
      <H1 lede="Retainer deploys an unmodified instance of Coinbase's audited router and transacts against Coinbase's canonical manager. Nothing here is Retainer's to audit.">Contracts and addresses</H1>

      <H2 id="deployed">Base Sepolia — chain 84532</H2>
      <Table head={["Contract", "Address", "Who deployed it"]} rows={[
        [<><C>SpendRouter</C> (Retainer&apos;s instance)</>, <Addr value="0x337099eE403C090388A66cc9370F7b0Fe4CDcC79" />, "Retainer. Verified source on Basescan; logic untouched."],
        [<><C>SpendPermissionManager</C></>, <Addr value="0xf85210B21cC50302F477BA56686d2019dC9b67Ad" />, "Coinbase. Canonical; same address on Base mainnet. Not redeployed."],
        [<><C>PublicERC6492Validator</C></>, <Addr value="0xcfCE48B757601F3f351CB6f434CB0517aEEE293D" />, "Coinbase. Canonical."],
        [<>USDC (testnet)</>, <Addr value="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />, "Circle."],
        [<><C>CoinbaseSmartWalletFactory</C></>, <Addr value="0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a" />, "Coinbase. Used by the scripted test account."],
      ]} />

      <H2 id="router">The router deployment</H2>
      <UL>
        <li>Deployment transaction: <Addr value="0x761cad85bf7a350b2c1c20352382a8c33f6550764d5485bc1d346257f691becb" tx /> — block 46564847, 1,631,793 gas.</li>
        <li>Compiler 0.8.30, optimiser on, 999,999 runs, EVM <C>cancun</C>. Verified through the Etherscan V2 API independently of the deploy tool&apos;s own report. <Cite file="contracts/deployments/base-sepolia.json" /></li>
        <li>Deployed with plain <C>CREATE</C>. Upstream&apos;s deploy script uses <C>CREATE2</C> through <C>0x4e59…eb8</C>, which has no code on Base Sepolia or Base mainnet. <Cite file="contracts/script/DeployRouter.s.sol" /></li>
        <li>The deploy script refuses any chain but 84532. <Cite file="contracts/script/DeployRouter.s.sol" line={33} /></li>
      </UL>

      <H2 id="provenance">Provenance</H2>
      <P>
        The three contract sources are copied verbatim from <C>coinbase/spend-permissions</C> at commit
        <C>e0004e63edc4e17de7aa978293800ac7a16892e5</C>. A script re-checks them against upstream by sha256 and fails if anything drifted.
        <Cite file="contracts/src/PROVENANCE.md" /> <Cite file="contracts/script/verify-vendor.sh" />
      </P>
      <Table head={["File", "sha256"]} rows={[
        [<C>SpendPermissionManager.sol</C>, <C>2a5a0d72f06cd1b66099d4e8ee9129dc5c52c75c46a4b42eeebf415b4fb2a231</C>],
        [<C>SpendRouter.sol</C>, <C>104e1a47fb47e3ebc92710721ac37a3b7c999081c1257b34608ab3aaf8d636f2</C>],
        [<C>PublicERC6492Validator.sol</C>, <C>f3cb49c5864badf20ccc7dfaccb0c98aa28c2a01520bf923d2087394f00433ca</C>],
      ]} />
      <P>
        The deployed manager&apos;s on-chain <C>SPEND_PERMISSION_TYPEHASH</C> equals <C>keccak256</C> of the type string in that vendored
        source, which is what makes &ldquo;the code we read is the code we transact against&rdquo; a checked statement.
        <Cite file="contracts/test/retainer/ErrorSelectors.t.sol" label="test_typehash_matchesDeployedManager" />
      </P>

      <H2 id="audits">Audits — upstream, not Retainer&apos;s</H2>
      <Table head={["Scope", "Dates", "Firm"]} rows={[
        [<C>SpendPermissionManager</C>, "October, November, December 2024", "Cantina"],
        [<C>SpendRouter</C>, "2026-03-18 and 2026-03-21", "Cantina"],
      ]} />
      <P>
        Reports live in upstream&apos;s <C>audits/</C> directory. Retainer has commissioned no audit of its own: its Solidity is limited to a
        deploy script and tests, and its off-chain code has not been reviewed by a third party.
      </P>

      <H2 id="events">Events the reconciler indexes</H2>
      <UL>
        <li><C>SpendPermissionUsed(bytes32,address,address,address,(uint48,uint48,uint160))</C> — topic <C>0xbcba65b4…6753c</C></li>
        <li><C>SpendRouted(address,address,address,bytes32,address,uint256)</C> — topic <C>0x92c3f8f6…c9dae</C></li>
      </UL>
      <P>Both topics, and every custom error selector the classifier decodes, are pinned by test so an upstream change cannot drift past unnoticed. <Cite file="contracts/test/retainer/ErrorSelectors.t.sol" /></P>

      <Callout kind="limit" title="Mainnet">
        There is no mainnet deployment. The Base Sepolia keys are disposable and are never to be reused on mainnet; a mainnet deployment
        would mean a new key set and a permanent public contract. Neither has been done.
      </Callout>
    </>
  );
}
