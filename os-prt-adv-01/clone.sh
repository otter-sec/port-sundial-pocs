#!/bin/sh

set -eux

rm -rf build
mkdir -p build

cd build
git clone https://github.com/port-finance/sundial

cd sundial
git checkout f8a7102a8025b7b33dff840d62231b4838fe8020

rm tests/*.spec.ts
cp ../../*.spec.ts tests

anchor build
yarn
yarn idl:generate
yarn test:e2e
