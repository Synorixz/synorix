'use strict';
// Synorix network parameters for bitcoinjs-lib (derived from src/kernel/chainparams.cpp).
// base58 prefixes: mainnet pubkey 63 / script 122 / wif 191; testnet 65 / 124 / 239.
// bech32 hrp: mainnet 'snrx', testnet 'tsnrx'. bip32 xpub/xprv from EXT_PUBLIC/SECRET_KEY.

const NETWORKS = {
  mainnet: {
    messagePrefix: '\x18Synorix Signed Message:\n',
    bech32: 'snrx',
    bip32: { public: 0x0488b21e, private: 0x0488ade4 },
    pubKeyHash: 63,
    scriptHash: 122,
    wif: 191,
  },
  testnet: {
    messagePrefix: '\x18Synorix Signed Message:\n',
    bech32: 'tsnrx',
    bip32: { public: 0x043587cf, private: 0x04358394 },
    pubKeyHash: 65,
    scriptHash: 124,
    wif: 239,
  },
};

module.exports = { NETWORKS };
