// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SpendPermissionManager} from "src/SpendPermissionManager.sol";
import {SpendRouterTestBase} from "test/src/SpendRouter/SpendRouterTestBase.sol";

/// @notice Retainer's core custody invariant: money never rests anywhere we control.
///
/// @dev Retainer holds the executor key and never holds funds. `SpendRouter`
///      pulls from the customer and forwards to the merchant treasury in one
///      atomic transaction, so the router's balance must be zero before and
///      after every charge. If this test ever fails, the non-custodial claim in
///      the regulatory analysis is void and the build must not ship.
contract RouterCustodyInvariantTest is SpendRouterTestBase {
    uint48 constant PERIOD = 30 days;
    uint160 constant ALLOWANCE = 1_000e18;

    function _approved(uint256 salt) internal returns (SpendPermissionManager.SpendPermission memory p) {
        p = _createPermission(address(token), ALLOWANCE, PERIOD, uint48(block.timestamp), type(uint48).max, salt);
        _approvePermission(p);
    }

    /// @dev Single charge: router is empty afterwards, recipient got everything.
    function test_routerHoldsNothing_afterSingleCharge(uint160 value) public {
        value = uint160(bound(value, 1, ALLOWANCE));
        token.mint(address(account), value);
        SpendPermissionManager.SpendPermission memory p = _approved(0);

        assertEq(token.balanceOf(address(router)), 0, "router dirty before charge");

        vm.prank(executor);
        router.spendAndRoute(p, value);

        assertEq(token.balanceOf(address(router)), 0, "ROUTER HELD FUNDS AFTER CHARGE");
        assertEq(token.balanceOf(recipient), value, "recipient did not receive full value");
        assertEq(token.balanceOf(address(account)), 0, "customer over/under-charged");
    }

    /// @dev Repeated charges within one period must not accrete dust in the router.
    function test_routerHoldsNothing_afterManyCharges(uint8 n) public {
        uint256 charges = bound(n, 2, 20);
        uint160 each = 1e18;
        token.mint(address(account), uint160(charges) * each);
        SpendPermissionManager.SpendPermission memory p = _approved(1);

        for (uint256 i; i < charges; ++i) {
            vm.prank(executor);
            router.spendAndRoute(p, each);
            assertEq(token.balanceOf(address(router)), 0, "ROUTER HELD FUNDS MID-SEQUENCE");
        }

        assertEq(token.balanceOf(recipient), uint256(charges) * each, "recipient total mismatch");
    }

    /// @dev The executor (Retainer's key) must never be enriched by a charge.
    function test_executorNeverReceivesFunds(uint160 value) public {
        value = uint160(bound(value, 1, ALLOWANCE));
        token.mint(address(account), value);
        SpendPermissionManager.SpendPermission memory p = _approved(2);

        uint256 executorBefore = token.balanceOf(executor);

        vm.prank(executor);
        router.spendAndRoute(p, value);

        assertEq(token.balanceOf(executor), executorBefore, "EXECUTOR RECEIVED FUNDS");
        assertEq(executor.balance, 0, "EXECUTOR RECEIVED NATIVE VALUE");
    }

    /// @dev A reverted charge must leave no residue and consume no allowance,
    ///      which is what makes retrying safe.
    function test_revertedChargeLeavesNoResidueAndNoAllowanceSpent() public {
        SpendPermissionManager.SpendPermission memory p = _approved(3);
        uint160 value = 10e18;
        // account holds nothing -> ERC20 transfer reverts
        vm.prank(executor);
        vm.expectRevert();
        router.spendAndRoute(p, value);

        assertEq(token.balanceOf(address(router)), 0, "router dirty after revert");
        assertEq(token.balanceOf(recipient), 0, "recipient credited on failed charge");
        assertEq(permissionManager.getCurrentPeriod(p).spend, 0, "allowance consumed by failed charge");
    }

    /// @dev Only the encoded executor may trigger a charge; a stolen permission
    ///      cannot be drained by an arbitrary caller.
    function test_onlyEncodedExecutorCanCharge(address caller) public {
        vm.assume(caller != executor);
        token.mint(address(account), 10e18);
        SpendPermissionManager.SpendPermission memory p = _approved(4);

        vm.prank(caller);
        vm.expectRevert();
        router.spendAndRoute(p, 1e18);

        assertEq(token.balanceOf(recipient), 0, "unauthorized caller moved funds");
    }
}
