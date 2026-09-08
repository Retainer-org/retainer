#!/bin/bash
set -e
cd "$(dirname "$0")/.."
mkdir -p lib && cd lib
clone() { # repo dir rev
  echo ">>> $2 @ $3"
  git clone -q "$1" "$2" 2>&1 | tail -2
  git -C "$2" checkout -q "$3"
  git -C "$2" submodule update -q --init --recursive 2>&1 | tail -2 || true
  rm -rf "$2/.git"
}
clone https://github.com/foundry-rs/forge-std forge-std 58d30519826c313ce47345abedfdc07679e944d1
clone https://github.com/OpenZeppelin/openzeppelin-contracts openzeppelin-contracts 1edc2ae004974ebf053f4eba26b45469937b9381
clone https://github.com/Vectorized/solady solady 5ea5d9f57ed6d24a27d00934f4a3448def931415
clone https://github.com/eth-infinitism/account-abstraction account-abstraction fa61290d37d079e928d92d53a122efcc63822214
clone https://github.com/base-org/webauthn-sol webauthn-sol 619f20ab0f074fef41066ee4ab24849a913263b2
clone https://github.com/coinbase/smart-wallet smart-wallet 1bc2d0aa3b7dc6f73bf2029c848cfb88c1104901
clone https://github.com/coinbase/magicspend magicspend 4ce54f16c53c8031d2168a1b7c3e83648a323019
echo "ALL DEPS INSTALLED"
