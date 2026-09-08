// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {PublicERC6492Validator} from "src/PublicERC6492Validator.sol";
import {SpendPermissionManager} from "src/SpendPermissionManager.sol";
import {SpendRouter} from "src/SpendRouter.sol";

/// @notice Guards Retainer's off-chain revert decoder against upstream drift.
///
/// @dev The charge engine classifies failures by decoding 4-byte custom error
///      selectors returned from `eth_call` / reverted receipts. Those selectors
///      are duplicated in TypeScript (`packages/chain/src/errors.ts`). If a
///      future vendored contract update changes an error's signature, the
///      TypeScript decoder would silently fall through to "unknown" and the
///      failure-mode classifier would stop working.
///
/// @dev This test pins every selector the decoder relies on. If it fails, update
///      BOTH this file and the TypeScript table — never just one.
contract ErrorSelectorsTest is Test {
    SpendPermissionManager internal manager;

    function setUp() public {
        // magicSpend is irrelevant here; we only read the EIP-712 typehash.
        manager = new SpendPermissionManager(new PublicERC6492Validator(), address(1));
    }

    // --- SpendPermissionManager: drives REVOKED / NOT_APPROVED / EXPIRED / ALLOWANCE_EXHAUSTED ---

    function test_selector_UnauthorizedSpendPermission() public pure {
        // Raised when !isValid(): revoked OR never approved. Off-chain we
        // disambiguate the two with isRevoked() before classifying.
        assertEq(bytes4(SpendPermissionManager.UnauthorizedSpendPermission.selector), bytes4(0x282b9f97));
    }

    function test_selector_ExceededSpendPermission() public pure {
        assertEq(bytes4(SpendPermissionManager.ExceededSpendPermission.selector), bytes4(0xfd1ebc88));
    }

    function test_selector_BeforeSpendPermissionStart() public pure {
        assertEq(bytes4(SpendPermissionManager.BeforeSpendPermissionStart.selector), bytes4(0x00a170cd));
    }

    function test_selector_AfterSpendPermissionEnd() public pure {
        assertEq(bytes4(SpendPermissionManager.AfterSpendPermissionEnd.selector), bytes4(0x4f0a481c));
    }

    function test_selector_ZeroValue() public pure {
        assertEq(bytes4(SpendPermissionManager.ZeroValue.selector), bytes4(0x7c946ed7));
    }

    function test_selector_InvalidSender() public pure {
        assertEq(bytes4(SpendPermissionManager.InvalidSender.selector), bytes4(0xe1130dba));
    }

    function test_selector_SpendValueOverflow() public pure {
        assertEq(bytes4(SpendPermissionManager.SpendValueOverflow.selector), bytes4(0xb27ed7ef));
    }

    function test_selector_InvalidSignature() public pure {
        assertEq(bytes4(SpendPermissionManager.InvalidSignature.selector), bytes4(0x8baa579f));
    }

    // --- SpendRouter: misconfiguration, not a billing state ---

    function test_selector_UnauthorizedSender() public pure {
        assertEq(bytes4(SpendRouter.UnauthorizedSender.selector), bytes4(0x85faaab5));
    }

    function test_selector_MalformedExtraData() public pure {
        assertEq(bytes4(SpendRouter.MalformedExtraData.selector), bytes4(0x784dc36e));
    }

    function test_selector_ZeroAddress() public pure {
        assertEq(bytes4(SpendRouter.ZeroAddress.selector), bytes4(0xd92e233d));
    }

    function test_selector_PermissionApprovalFailed() public pure {
        assertEq(bytes4(SpendRouter.PermissionApprovalFailed.selector), bytes4(0x5c60991a));
    }

    // --- Events the reconciler indexes ---

    function test_topic_SpendPermissionUsed() public pure {
        assertEq(
            keccak256("SpendPermissionUsed(bytes32,address,address,address,(uint48,uint48,uint160))"),
            bytes32(0xbcba65b462dfff1a0af642e2ccd28778c64fcb16da2132dabf6eee8906d6753c)
        );
    }

    function test_topic_SpendRouted() public pure {
        assertEq(
            keccak256("SpendRouted(address,address,address,bytes32,address,uint256)"),
            bytes32(0x92c3f8f60a0c7ca7a50adb413da33506eb75fc593454b029f7047bab392c9dae)
        );
    }

    /// @dev The EIP-712 typehash of the deployed canonical manager on Base and
    ///      Base Sepolia. Proves the vendored source matches the bytecode we
    ///      actually transact against.
    function test_typehash_matchesDeployedManager() public view {
        assertEq(
            manager.SPEND_PERMISSION_TYPEHASH(),
            bytes32(0xc9fa0f0252014cf89ab0539e3bb3adcb76f93e6bb6494e8cc61c14e2761ee2e4)
        );
    }
}
