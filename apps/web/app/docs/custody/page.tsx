import { H1, H2, P, UL, C, Cite, Callout, Pre, Table } from "@/components/docs/prose";

export default function Custody() {
  return (
    <>
      <H1 lede="Retainer holds the executor key, which can trigger a charge, and never holds funds. This page is the argument and the test that backs it.">Custody model</H1>

      <H2 id="flow">Customer → router → merchant, in one transaction</H2>
      <Pre title="one call to SpendRouter.spendAndRoute">{`executor (Retainer's key)
   │  spendAndRoute(permission, value)        msg.sender must equal extraData.executor
   ▼
SpendRouter
   │  PERMISSION_MANAGER.spend(permission, value)
   │     └─ manager executes on the customer's account: approve + transferFrom → router
   │  emit SpendRouted(account, executor, recipient, hash, token, value)
   │  _routeTokens(token, recipient, value)   forwards exactly \`value\` to the merchant treasury
   ▼
merchant treasury`}</Pre>
      <P>
        All of that is one transaction. If the forward to the recipient fails, the whole call reverts, including the pull from the customer.
        There is no state in which the router has received funds and not yet forwarded them. <Cite file="contracts/src/SpendRouter.sol" line={114} />
      </P>

      <H2 id="invariant">The invariant, as a test that fails the build</H2>
      <P>
        <C>RouterCustodyInvariant.t.sol</C> asserts the router&apos;s token balance is zero before and after a charge, that a sequence of
        charges accretes no dust, that the executor is never enriched, that a reverted charge leaves no residue and consumes no allowance,
        and that only the encoded executor can trigger a charge. Each property runs 256 fuzz iterations. If any fails, the build fails.
      </P>
      <Table head={["Test", "Asserts"]} rows={[
        [<C>test_routerHoldsNothing_afterSingleCharge</C>, "router balance 0 after; recipient received exactly the value"],
        [<C>test_routerHoldsNothing_afterManyCharges</C>, "router balance 0 after every charge in a sequence of up to 20"],
        [<C>test_executorNeverReceivesFunds</C>, "executor token and native balances unchanged"],
        [<C>test_revertedChargeLeavesNoResidueAndNoAllowanceSpent</C>, "after a revert: router 0, recipient 0, period spend 0"],
        [<C>test_onlyEncodedExecutorCanCharge</C>, "any other caller reverts and moves nothing"],
      ]} />
      <P><Cite file="contracts/test/retainer/RouterCustodyInvariant.t.sol" line={24} /> — passing under both the default profile and the optimiser profile the deployed bytecode was built with.</P>

      <H2 id="live">And on the live chain</H2>
      <P>
        After the six confirmed Phase 1 charges, the merchant treasury held exactly their sum — 7,050,000 base units, 7.05 USDC — and the
        router and executor held 0 USDC. Those balances were read live before being written here, on 2026-09-09. They are on Base Sepolia
        for anyone to check.
      </P>
      <UL>
        <li>router: <C>0x337099eE403C090388A66cc9370F7b0Fe4CDcC79</C></li>
        <li>merchant treasury: <C>0x47dB2024f26E4bDe719178F567785d8A10106A67</C></li>
        <li>executor: <C>0xE3Fe27364750d62Cbb14fd648E8cf451eF227087</C></li>
      </UL>

      <H2 id="consequence">A structural consequence: no fee in the flow</H2>
      <P>
        The router encodes exactly one recipient and forwards the full value. There is no fee split. Retainer cannot take a percentage of a
        charge without becoming the recipient and forwarding — which is precisely the custodial path this design rules out. Any Retainer
        revenue therefore has to be a flat fee to the merchant, collected outside the flow. That is a business-model decision, made, not a
        problem to solve in code. <Cite file="contracts/src/SpendRouter.sol" line={17} />
      </P>

      <Callout kind="warn" title="What custody does not cover">
        Retainer cannot execute refunds. There is no reverse-spend; a refund is a push from the merchant&apos;s treasury with the merchant&apos;s
        key. A non-custodial billing layer can only instruct, not perform, a refund. This is a real gap against card processors and it is
        listed under limitations.
      </Callout>
    </>
  );
}
