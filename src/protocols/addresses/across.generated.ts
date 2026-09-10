import type { Address } from "viem";

/**
 * Across SpokePool per EVM chain id - the contract that actually holds the
 * bridged funds, so its balance is the liquidity available to withdraw.
 *
 * GENERATED FILE. Do not edit by hand: run `npm run sync:across`, which
 * reads Across's own published deployments. Keyed by chain id rather than by
 * name, so a chain added to chains.ts is picked up without a second mapping
 * to get wrong.
 *
 * Source: @across-protocol/contracts@5.0.26, dist/broadcast/deployed-addresses.json
 * Mainnet EVM chains only; testnets and non-EVM deployments are dropped.
 */
export const ACROSS_SPOKE_POOL_BY_CHAIN_ID: Record<number, Address> = {
  1: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5", // Ethereum
  10: "0x6f26Bf09B1C792e3228e5467807a900A503c0281", // OP Mainnet
  56: "0x4e8E101924eDE233C13e2D8622DC8aED2872d505", // BNB Smart Chain
  130: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", // Unichain
  137: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096", // Polygon
  143: "0xd2ecb3afe598b746F8123CaE365a598DA831A449", // Monad
  232: "0xb234cA484866c811d0e6D3318866F583781ED045", // Lens
  288: "0xBbc6009fEfFc27ce705322832Cb2068F8C1e0A58", // Boba Network
  324: "0xE0B015E54d54fc84a6cB9B666099c46adE9335FF", // ZKsync Era
  480: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", // World Chain
  999: "0x35E63eA3eb0fb7A3bc543C71FB66412e1F6B0E04", // HyperEVM
  1135: "0x9552a0a6624A23B848060AE5901659CDDa1f83f8", // Lisk
  1868: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96", // Soneium Mainnet
  4217: "0x2d4710F04Da90184255782d3715224A6C776955D", // Tempo Mainnet
  4326: "0x3Db06DA8F0a24A525f314eeC954fC5c6a973d40E", // MegaETH
  4663: "0xD29C85F15DF544bA632C9E25829fd29d767d7978", // Robinhood Chain
  5042: "0x9b4A302A548c7e313c2b74C461db7b84d3074A84", // Arc
  8453: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", // Base
  9745: "0x50039fAEfebef707cFD94D6d462fE6D10B39207a", // Plasma
  34443: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96", // Mode Mainnet
  42161: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A", // Arbitrum One
  43114: "0xFE9D541c92E4e90437C7152A00244886dE37a658", // Avalanche
  57073: "0xeF684C38F94F48775959ECf2012D7E864ffb9dd4", // Ink
  59144: "0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75", // Linea Mainnet
  81457: "0x2D509190Ed0172ba588407D4c2df918F955Cc6E1", // Blast
  534352: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96", // Scroll
  7777777: "0x13fDac9F9b4777705db45291bbFF3c972c6d1d97", // Zora
};
