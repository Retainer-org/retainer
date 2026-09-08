#!/usr/bin/env bash
# Re-verify that src/*.sol are byte-identical to the audited upstream source.
# Fails loudly if anything drifted. Run in CI.
set -euo pipefail
PIN=e0004e63edc4e17de7aa978293800ac7a16892e5
REPO=https://raw.githubusercontent.com/coinbase/spend-permissions/$PIN/src
cd "$(dirname "$0")/../src"
fail=0
for f in SpendPermissionManager.sol SpendRouter.sol PublicERC6492Validator.sol; do
  local_h=$(shasum -a 256 "$f" | cut -d' ' -f1)
  up_h=$(curl -fsSL "$REPO/$f" | shasum -a 256 | cut -d' ' -f1)
  if [ "$local_h" = "$up_h" ]; then
    echo "ok    $f"
  else
    echo "DRIFT $f"; echo "  local:    $local_h"; echo "  upstream: $up_h"; fail=1
  fi
done
[ $fail -eq 0 ] || { echo "Vendored source has been modified. This voids the upstream audits."; exit 1; }
echo "All vendored contracts match coinbase/spend-permissions@$PIN"
