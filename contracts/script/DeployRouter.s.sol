// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";

import {SpendPermissionManager} from "../src/SpendPermissionManager.sol";
import {SpendRouter} from "../src/SpendRouter.sol";

/// @notice Deploy Retainer's own instance of the audited `SpendRouter`.
///
/// @dev We deploy ONLY the router. `SpendPermissionManager` is already deployed
///      canonically at the same address on every supported chain and is NOT
///      redeployed here.
///
/// @dev Upstream's `Deploy.s.sol` uses `new SpendRouter{salt: 0}(...)`, which
///      requires the deterministic CREATE2 deployer at
///      0x4e59b44847b379578588920cA78FaF26c0B45eb8. That address has no code on
///      Base or Base Sepolia (verified 2026-09-08 against two independent RPCs),
///      so we use plain CREATE instead. The router's address does not need to be
///      deterministic — it is recorded in deployments/ and referenced by address.
///
/// forge script DeployRouter --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --verify \
///   --etherscan-api-key $BASESCAN_API_KEY --profile deploy -vvv
contract DeployRouter is Script {
    /// @dev Canonical, identical on Base mainnet and Base Sepolia.
    address constant SPEND_PERMISSION_MANAGER = 0xf85210B21cC50302F477BA56686d2019dC9b67Ad;

    /// @dev Chain IDs this script is allowed to run against. Base Sepolia only:
    ///      Phase 1 is testnet-only and mainnet deployment is explicitly out of scope.
    uint256 constant BASE_SEPOLIA = 84532;

    function run() external {
        require(block.chainid == BASE_SEPOLIA, "DeployRouter: Base Sepolia only (mainnet is out of scope)");
        require(SPEND_PERMISSION_MANAGER.code.length > 0, "DeployRouter: manager has no code on this chain");

        vm.startBroadcast();
        SpendRouter router = new SpendRouter(SpendPermissionManager(payable(SPEND_PERMISSION_MANAGER)));
        vm.stopBroadcast();

        // Post-conditions: the router must be bound to the manager we intended.
        require(address(router.PERMISSION_MANAGER()) == SPEND_PERMISSION_MANAGER, "DeployRouter: manager mismatch");

        console2.log("chainId                :", block.chainid);
        console2.log("SpendPermissionManager :", SPEND_PERMISSION_MANAGER);
        console2.log("SpendRouter (deployed) :", address(router));
    }
}
