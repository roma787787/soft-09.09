import type { Address } from "viem";

/**
 * Chainlink CCIP deployments, as Chainlink publishes them.
 *
 * GENERATED FILE. Do not edit by hand: run \`npm run sync:ccip\`, which reads
 * the directory behind the public CCIP docs and joins it to EVM chain ids
 * through Chainlink's own selector registry.
 */
export interface CcipEvmDeployment {
  chainId: number;
  /** Chainlink's own name for the chain, kept so a row can be traced back. */
  ccipKey: string;
  selector: string;
  router: Address;
  /**
   * Where the pool lookup starts. Published per chain, which saves the walk
   * from the Router through an OffRamp and an OnRamp to find it - four calls
   * that each had to succeed, on a chain that may answer none of them.
   */
  tokenAdminRegistry?: Address;
}

export const CCIP_EVM_DEPLOYMENTS: CcipEvmDeployment[] = [
  {
    chainId: 1,
    ccipKey: "mainnet",
    selector: "5009297550715157269",
    router: "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D",
    tokenAdminRegistry: "0xb22764f98dD05c789929716D677382Df22C05Cb6",
  },
  {
    chainId: 10,
    ccipKey: "ethereum-mainnet-optimism-1",
    selector: "3734403246176062136",
    router: "0x3206695CaE29952f4b0c22a169725a865bc8Ce0f",
    tokenAdminRegistry: "0x657c42abE4CD8aa731Aec322f871B5b90cf6274F",
  },
  {
    chainId: 25,
    ccipKey: "cronos-mainnet",
    selector: "1456215246176062136",
    router: "0xE26B0A098D861d5C7d9434aD471c0572Ca6EAa67",
    tokenAdminRegistry: "0x32c4634338f1386fdD18E0bD6dF51Ca2Fa56f762",
  },
  {
    chainId: 30,
    ccipKey: "rootstock-mainnet",
    selector: "11964252391146578476",
    router: "0xCe7aFb0BF5F73BfDB5e9E04976eBac2005746bD0",
    tokenAdminRegistry: "0xad71ac82aCFCbDD27BBd3F3eD2fA24E26E49CBE2",
  },
  {
    chainId: 50,
    ccipKey: "xdc-mainnet",
    selector: "17673274061779414707",
    router: "0x2a9f896660E802c59a3178b2E8CB7FBaCCC04e86",
    tokenAdminRegistry: "0xEC1276CA704c612A28cb2C873dEdCEba97F65cED",
  },
  {
    chainId: 56,
    ccipKey: "bsc-mainnet",
    selector: "11344663589394136015",
    router: "0x34B03Cb9086d7D758AC55af71584F81A598759FE",
    tokenAdminRegistry: "0x736Fd8660c443547a85e4Eaf70A49C1b7Bb008fc",
  },
  {
    chainId: 100,
    ccipKey: "xdai-mainnet",
    selector: "465200170687744372",
    router: "0x4aAD6071085df840abD9Baf1697d5D5992bDadce",
    tokenAdminRegistry: "0x73BC11423CBF14914998C23B0aFC9BE0cb5B2229",
  },
  {
    chainId: 109,
    ccipKey: "shibarium-mainnet",
    selector: "3993510008929295315",
    router: "0xc2CA5d5C17911e4B838194b51585DdF8fe5116C1",
    tokenAdminRegistry: "0x995d2Aa233aBeaCA2a64Edf898AE9F4e01bE15B9",
  },
  {
    chainId: 130,
    ccipKey: "ethereum-mainnet-unichain-1",
    selector: "1923510103922296319",
    router: "0x68891f5F96695ECd7dEdBE2289D1b73426ae7864",
    tokenAdminRegistry: "0xAB3Ee2e897cf23c10e76d26aB4674fEFA376bc0d",
  },
  {
    chainId: 137,
    ccipKey: "matic-mainnet",
    selector: "4051577828743386545",
    router: "0x849c5ED5a80F5B408Dd4969b78c2C8fdf0565Bfe",
    tokenAdminRegistry: "0x00F027eA6D0fb03256A15E9182B2B9227A4931d8",
  },
  {
    chainId: 143,
    ccipKey: "monad-mainnet",
    selector: "8481857512324358265",
    router: "0x33566fE5976AAa420F3d5C64996641Fc3858CaDB",
    tokenAdminRegistry: "0x11ACd984DD680363117B310f6ebdf78fD6c0195f",
  },
  {
    chainId: 146,
    ccipKey: "sonic-mainnet",
    selector: "1673871237479749969",
    router: "0xB4e1Ff7882474BB93042be9AD5E1fA387949B860",
    tokenAdminRegistry: "0x2961Cb47b5111F38d75f415c21ceB4120ddd1b69",
  },
  {
    chainId: 177,
    ccipKey: "ethereum-mainnet-hashkey-1",
    selector: "7613811247471741961",
    router: "0xf2Fd62c083F3BF324e99ce157D1a42d7EbA77f1d",
    tokenAdminRegistry: "0x4b238f757f842280FeA88A1c2B4186b71eF8BC5E",
  },
  {
    chainId: 196,
    ccipKey: "ethereum-mainnet-xlayer-1",
    selector: "3016212468291539606",
    router: "0xF2b6Cb7867EB5502C3249dD37D7bc1Cc148e5232",
    tokenAdminRegistry: "0xeCf1eAEE01E82F3388dECD7f4C3792374f3f72F3",
  },
  {
    chainId: 204,
    ccipKey: "binance-smart-chain-mainnet-opbnb-1",
    selector: "465944652040885897",
    router: "0xa3ca4306B9256aAB177C47A18b43593F03378976",
    tokenAdminRegistry: "0xEfF5D2147F9cAcdedF80C2ee1F5320B01C664bE5",
  },
  {
    chainId: 223,
    ccipKey: "bitcoin-mainnet-bsquared-1",
    selector: "5406759801798337480",
    router: "0x9C34e9A192d7a4c2cf054668C1122C028C43026c",
    tokenAdminRegistry: "0x2e1543255119CfB9D3501E32d7f5B244E59A06F4",
  },
  {
    chainId: 232,
    ccipKey: "lens-mainnet",
    selector: "5608378062013572713",
    router: "0x498F3feBAd3ff75e05b7847B37a301fc2DA6fDC0",
    tokenAdminRegistry: "0xdD98482Ec0cfEFfe14EAb750A9c484F9D5d07380",
  },
  {
    chainId: 252,
    ccipKey: "fraxtal-mainnet",
    selector: "1462016016387883143",
    router: "0x4bdF20477744Ec5F9DE738b5cC9ACd01763905ee",
    tokenAdminRegistry: "0x6724621d8A560A84E4B6012c4bAA0eA6fF47B9DF",
  },
  {
    chainId: 295,
    ccipKey: "hedera-mainnet",
    selector: "3229138320728879060",
    router: "0x87b400B4d4F5Fe2Fdb6FBEa66C38003ced565b76",
    tokenAdminRegistry: "0xC9efBD4f73C37aE1573806030A4146e1E72EADc1",
  },
  {
    chainId: 324,
    ccipKey: "ethereum-mainnet-zksync-1",
    selector: "1562403441176082196",
    router: "0x748Fd769d81F5D94752bf8B0875E9301d0ba71bB",
    tokenAdminRegistry: "0x100a47C9DB342884E3314B91cec076BbAC8e619c",
  },
  {
    chainId: 388,
    ccipKey: "cronos-zkevm-mainnet",
    selector: "8788096068760390840",
    router: "0x17b828DF8679D68318f0849C1221AD1760699eCb",
    tokenAdminRegistry: "0x94Fa8b263dEb66fA3e160D408Cd200be8b030609",
  },
  {
    chainId: 480,
    ccipKey: "ethereum-mainnet-worldchain-1",
    selector: "2049429975587534727",
    router: "0x5fd9E4986187c56826A3064954Cfa2Cf250cfA0f",
    tokenAdminRegistry: "0x02Fe6ab4fb0943F58D9D925d1d2cbA9474997Ed0",
  },
  {
    chainId: 592,
    ccipKey: "polkadot-mainnet-astar",
    selector: "6422105447186081193",
    router: "0x8D5c5CB8ec58285B424C93436189fB865e437feF",
    tokenAdminRegistry: "0xB98eEd70e3cE8E342B0f770589769E3A6bc20A09",
  },
  {
    chainId: 964,
    ccipKey: "bittensor-mainnet",
    selector: "2135107236357186872",
    router: "0xD941fBEcD2b971d0F54b4C34286C95faB52B60B8",
    tokenAdminRegistry: "0xe72d25aDd538E8ef9CeF85622eA8912a6CB98Be6",
  },
  {
    chainId: 988,
    ccipKey: "stable-mainnet",
    selector: "16978377838628290997",
    router: "0xECFF67559c0583027A5fbd85136E33bC4D66eeA0",
    tokenAdminRegistry: "0x3c23e6FB09064e9A64829Fa8FEe27Ad19A27Bfa9",
  },
  {
    chainId: 999,
    ccipKey: "hyperliquid-mainnet",
    selector: "2442541497099098535",
    router: "0x13b3332b66389B1467CA6eBd6fa79775CCeF65ec",
    tokenAdminRegistry: "0xcE44363496ABc3a9e53B3F404a740F992D977bDF",
  },
  {
    chainId: 1088,
    ccipKey: "ethereum-mainnet-andromeda-1",
    selector: "8805746078405598895",
    router: "0x7b9FB8717D306e2e08ce2e1Efa81F026bf9AD13c",
    tokenAdminRegistry: "0x3af897541eB03927c7431bF68884A6C2C23b683f",
  },
  {
    chainId: 1111,
    ccipKey: "wemix-mainnet",
    selector: "5142893604156789321",
    router: "0x7798b795Fde864f4Cd1b124a38Ba9619B7F8A442",
    tokenAdminRegistry: "0xE993e046AC50659800a91Bab0bd2daBF59CbD171",
  },
  {
    chainId: 1116,
    ccipKey: "core-mainnet",
    selector: "1224752112135636129",
    router: "0xF7Cc8b0B5263A74AFBb1a2ac87FfF1CF7E62152f",
    tokenAdminRegistry: "0x4D2B43c60f3e476Ee94637C4e3be844FC9a70012",
  },
  {
    chainId: 1135,
    ccipKey: "lisk-mainnet",
    selector: "15293031020466096408",
    router: "0x0145c1fbA8a16128c1061eB9CE7eC3cadb8e30c7",
    tokenAdminRegistry: "0x98acD723D0E9C13d09Df4619Abec729F3434a10a",
  },
  {
    chainId: 1329,
    ccipKey: "sei-mainnet",
    selector: "9027416829622342829",
    router: "0xAba60dA7E88F7E8f5868C2B6dE06CB759d693af0",
    tokenAdminRegistry: "0x910a46cA93E8086BF1d7D65190eE6AEe5256Bd61",
  },
  {
    chainId: 1672,
    ccipKey: "pharos-mainnet",
    selector: "7801139999541420232",
    router: "0x4e52dD94e9BCfeFE3C78153bDfB0AB1d30687297",
    tokenAdminRegistry: "0xB79791184973589c38e114D43Eb8E4588C283A18",
  },
  {
    chainId: 1750,
    ccipKey: "metal-mainnet",
    selector: "13447077090413146373",
    router: "0x020c61ECEEE0E5DC32F2503AbB6E070fa0EbBfaA",
    tokenAdminRegistry: "0xc41640B959Ca2A62b9293509202D8615dC293634",
  },
  {
    chainId: 1868,
    ccipKey: "soneium-mainnet",
    selector: "12505351618335765396",
    router: "0x8C8B88d827Fe14Df2bc6392947d513C86afD6977",
    tokenAdminRegistry: "0x5ba21F6824400B91F232952CA6d7c8875C1755a4",
  },
  {
    chainId: 2020,
    ccipKey: "ronin-mainnet",
    selector: "6916147374840168594",
    router: "0x46527571D5D1B68eE7Eb60B18A32e6C60DcEAf99",
    tokenAdminRegistry: "0x90e83d532A4aD13940139c8ACE0B93b0DdbD323a",
  },
  {
    chainId: 2741,
    ccipKey: "abstract-mainnet",
    selector: "3577778157919314504",
    router: "0x09521B0B5BB2d4406124c0207Cf551829B45f84d",
    tokenAdminRegistry: "0x7EEdf2DBC74924Cb1f23fC8845CD35bF18b697de",
  },
  {
    chainId: 2818,
    ccipKey: "morph-mainnet",
    selector: "18164309074156128038",
    router: "0x3201a20D2a33820C0DaC8Bc93C4819755C2a8c7F",
    tokenAdminRegistry: "0xEfd5fEFEdE55B5C41B8fa0d171a79ba5BeadD2Aa",
  },
  {
    chainId: 3343,
    ccipKey: "edge-mainnet",
    selector: "6325494908023253251",
    router: "0x0aA145a62153190B8f0D3cA00c441e451529f755",
    tokenAdminRegistry: "0x051665f2455116e929b9972c36d23070F5054Ce0",
  },
  {
    chainId: 3637,
    ccipKey: "bitcoin-mainnet-botanix",
    selector: "4560701533377838164",
    router: "0x5EE890c89B5Ae75cBC516Dd53345e38E5B39B664",
    tokenAdminRegistry: "0x3eD4752266fF42FECe47dB8BA1249fF3978f3E5E",
  },
  {
    chainId: 4200,
    ccipKey: "bitcoin-merlin-mainnet",
    selector: "241851231317828981",
    router: "0x8Be462D21b05eEeF81a3AA384b7C6CF18597232A",
    tokenAdminRegistry: "0xA51Cdb9154bB0c9Bc3CE25dBf7DE3331B3A1C8E7",
  },
  {
    chainId: 4217,
    ccipKey: "tempo-mainnet",
    selector: "7281642695469137430",
    router: "0xa132F089492CcE5f1D79483a9e4552f37266ed01",
    tokenAdminRegistry: "0x60A97bd9ACf755954Ff0fE85837224f2920a57F3",
  },
  {
    chainId: 4326,
    ccipKey: "megaeth-mainnet",
    selector: "6093540873831549674",
    router: "0xfa546248C54939AA6C48279CdC1EAf9A1125c411",
    tokenAdminRegistry: "0xf4a170A36D4C656F614d44453f73308Bdb275196",
  },
  {
    chainId: 4663,
    ccipKey: "robinhood-mainnet",
    selector: "6180753054346818345",
    router: "0x06fC836cf9839B1cd891C440A0a45242DA6Ae1c9",
    tokenAdminRegistry: "0x1912C3cFafE8A76A32a92861d815aC2837F237Ca",
  },
  {
    chainId: 5000,
    ccipKey: "ethereum-mainnet-mantle-1",
    selector: "1556008542357238666",
    router: "0x670052635a9850bb45882Cb2eCcF66bCff0F41B7",
    tokenAdminRegistry: "0x000A744940eB5D857c0d61d97015DFc83107404F",
  },
  {
    chainId: 5330,
    ccipKey: "superseed-mainnet",
    selector: "470401360549526817",
    router: "0xAD93FBB3A9a077F896e1F57739e43dEd063f181F",
    tokenAdminRegistry: "0x7a1874cBc865580c6cbE09af25509dF12A6b4F58",
  },
  {
    chainId: 8217,
    ccipKey: "kaia-mainnet",
    selector: "9813823125703490621",
    router: "0x4Eb2a60AF37bC6bb05500F581c00E8EA3075f6E9",
    tokenAdminRegistry: "0x75b48579Fb886C04E54b53038970a2BA19B75e09",
  },
  {
    chainId: 8453,
    ccipKey: "ethereum-mainnet-base-1",
    selector: "15971525489660198786",
    router: "0x881e3A65B4d4a04dD529061dd0071cf975F58bCD",
    tokenAdminRegistry: "0x6f6C373d09C07425BaAE72317863d7F6bb731e37",
  },
  {
    chainId: 9745,
    ccipKey: "plasma-mainnet",
    selector: "9335212494177455608",
    router: "0xcDca5D374e46A6DDDab50bD2D9acB8c796eC35C3",
    tokenAdminRegistry: "0xc23071a8AE83671f37bdA1DaDBC745a9780f632A",
  },
  {
    chainId: 16661,
    ccipKey: "0g-mainnet",
    selector: "4426351306075016396",
    router: "0x0aA145a62153190B8f0D3cA00c441e451529f755",
    tokenAdminRegistry: "0x051665f2455116e929b9972c36d23070F5054Ce0",
  },
  {
    chainId: 33139,
    ccipKey: "apechain-mainnet",
    selector: "14894068710063348487",
    router: "0xe9c6945281028cb6530d43F998eE539dFE2a9191",
    tokenAdminRegistry: "0xD3ED6fC9fd22412764ac2Ef64fB664b9393dF9F2",
  },
  {
    chainId: 34443,
    ccipKey: "ethereum-mainnet-mode-1",
    selector: "7264351850409363825",
    router: "0x24C40f13E77De2aFf37c280BA06c333531589bf1",
    tokenAdminRegistry: "0xB4b40c010A547dff6A22d94bC2C1c1e745b62aB2",
  },
  {
    chainId: 36888,
    ccipKey: "ab-mainnet",
    selector: "4829375610284793157",
    router: "0x492641F648a4986844848E0beFE66D14817bCE34",
    tokenAdminRegistry: "0xA27056438FfA1f286AB197488808692F0db93F8B",
  },
  {
    chainId: 36900,
    ccipKey: "adi-mainnet",
    selector: "4059281736450291836",
    router: "0x010771998A1F4736BD844939d0bf01ac5cA0f8fa",
    tokenAdminRegistry: "0x5fA6f142EAC511DF12325776386AB92B0F4D1eba",
  },
  {
    chainId: 42161,
    ccipKey: "ethereum-mainnet-arbitrum-1",
    selector: "4949039107694359620",
    router: "0x141fa059441E0ca23ce184B6A78bafD2A517DdE8",
    tokenAdminRegistry: "0x39AE1032cF4B334a1Ed41cdD0833bdD7c7E7751E",
  },
  {
    chainId: 42220,
    ccipKey: "celo-mainnet",
    selector: "1346049177634351622",
    router: "0xfB48f15480926A4ADf9116Dca468bDd2EE6C5F62",
    tokenAdminRegistry: "0xf19e0555fAA9051e277eeD5A0DcdB13CDaca39a9",
  },
  {
    chainId: 42793,
    ccipKey: "etherlink-mainnet",
    selector: "13624601974233774587",
    router: "0x1912C3cFafE8A76A32a92861d815aC2837F237Ca",
    tokenAdminRegistry: "0x492641F648a4986844848E0beFE66D14817bCE34",
  },
  {
    chainId: 43111,
    ccipKey: "hemi-mainnet",
    selector: "1804312132722180201",
    router: "0x5e48912cFDd14417D6856872341f894AE0EF07DD",
    tokenAdminRegistry: "0x81e81F9B2C0B79C00F38357068AE049090F2DaDE",
  },
  {
    chainId: 43114,
    ccipKey: "avalanche-mainnet",
    selector: "6433500567565415381",
    router: "0xF4c7E640EdA248ef95972845a62bdC74237805dB",
    tokenAdminRegistry: "0xc8df5D618c6a59Cc6A311E96a39450381001464F",
  },
  {
    chainId: 47763,
    ccipKey: "neox-mainnet",
    selector: "7222032299962346917",
    router: "0xd18b6b2306920d8Ae13b4A2D06b55AD36A6Fa2C7",
    tokenAdminRegistry: "0x344FCBb30EC9ECf58c8399EDe0430592E6703BC1",
  },
  {
    chainId: 48900,
    ccipKey: "ethereum-mainnet-zircuit-1",
    selector: "17198166215261833993",
    router: "0x0A6436B56378D305729713ac332ccdCD367f3918",
    tokenAdminRegistry: "0x47d2D93EEDb694bf445E7F6458f17669459612c7",
  },
  {
    chainId: 57073,
    ccipKey: "ethereum-mainnet-ink-1",
    selector: "3461204551265785888",
    router: "0xca7c90A52B44E301AC01Cb5EB99b2fD99339433A",
    tokenAdminRegistry: "0xEb062d21c713A3d940BB0FaECFdC387d6Ea23697",
  },
  {
    chainId: 59144,
    ccipKey: "ethereum-mainnet-linea-1",
    selector: "4627098889531055414",
    router: "0x549FEB73F2348F6cD99b9fc8c69252034897f06C",
    tokenAdminRegistry: "0xBc933cEE67d2b1c08490ee8C51E2dF653a713534",
  },
  {
    chainId: 60808,
    ccipKey: "bitcoin-mainnet-bob-1",
    selector: "3849287863852499584",
    router: "0x827716e74F769AB7b6bb374A29235d9c2156932C",
    tokenAdminRegistry: "0xa57d04119AFf4884F8602213E58d8AaAD18229cb",
  },
  {
    chainId: 61901,
    ccipKey: "mova-mainnet-2",
    selector: "4215185756725900654",
    router: "0x492641F648a4986844848E0beFE66D14817bCE34",
    tokenAdminRegistry: "0xA27056438FfA1f286AB197488808692F0db93F8B",
  },
  {
    chainId: 68414,
    ccipKey: "nexon-mainnet-henesys",
    selector: "12657445206920369324",
    router: "0x492641F648a4986844848E0beFE66D14817bCE34",
    tokenAdminRegistry: "0xA27056438FfA1f286AB197488808692F0db93F8B",
  },
  {
    chainId: 80094,
    ccipKey: "berachain-mainnet",
    selector: "1294465214383781161",
    router: "0x71a275704c283486fBa26dad3dd0DB78804426eF",
    tokenAdminRegistry: "0x0944C3Fb1dB7D165336569221995B31cBE6c8A55",
  },
  {
    chainId: 98866,
    ccipKey: "plume-mainnet",
    selector: "17912061998839310979",
    router: "0x5C4f4622AD0EC4a47e04840db7E9EcA8354109af",
    tokenAdminRegistry: "0x01E5B2fAC7156c54f034E1767f2799fDd41B8285",
  },
  {
    chainId: 102030,
    ccipKey: "creditcoin-mainnet",
    selector: "18240105181246962294",
    router: "0x1bADBe95bEe68D3a74EC08621256ddDBe6eAd3F9",
    tokenAdminRegistry: "0xD941fBEcD2b971d0F54b4C34286C95faB52B60B8",
  },
  {
    chainId: 167000,
    ccipKey: "ethereum-mainnet-taiko-1",
    selector: "16468599424800719238",
    router: "0xeb2502AeD3Cfd6E37e292c6B837a8FFF9a042367",
    tokenAdminRegistry: "0x308a2A7d13B12ba26649F381C53F7e7C60d0D9c6",
  },
  {
    chainId: 200901,
    ccipKey: "bitcoin-mainnet-bitlayer-1",
    selector: "7937294810946806131",
    router: "0x6c0aA29330c58dda07faD577fF5a0280823a910c",
    tokenAdminRegistry: "0xd999758aEB04BDa755Ae78344FFF5534947620CD",
  },
  {
    chainId: 534352,
    ccipKey: "ethereum-mainnet-scroll-1",
    selector: "13204309965629103672",
    router: "0x9a55E8Cab6564eb7bbd7124238932963B8Af71DC",
    tokenAdminRegistry: "0x846dEA1c1706FC35b4aa78B32d31F1599DAA47b4",
  },
  {
    chainId: 747474,
    ccipKey: "polygon-mainnet-katana",
    selector: "2459028469735686113",
    router: "0x7c19b79D2a054114Ab36ad758A36e92376e267DA",
    tokenAdminRegistry: "0x048B911A1AE5dD4f0aEE5241A30d3DEDa3501D54",
  },
  {
    chainId: 5734951,
    ccipKey: "jovay-mainnet",
    selector: "1523760397290643893",
    router: "0x492641F648a4986844848E0beFE66D14817bCE34",
    tokenAdminRegistry: "0xA27056438FfA1f286AB197488808692F0db93F8B",
  },
  {
    chainId: 7777777,
    ccipKey: "zora-mainnet",
    selector: "3555797439612589184",
    router: "0x65b40941fa86Fc444043257cd677a7F0bD034F79",
    tokenAdminRegistry: "0x791BA3010A5BFeA773d2cfD6Ea4D0Ce9627856eB",
  },
  {
    chainId: 21000000,
    ccipKey: "corn-mainnet",
    selector: "9043146809313071210",
    router: "0x183f6069A0D5c2DEC1Dd1eCF3B1581e12dEb4Efe",
    tokenAdminRegistry: "0xCd51e57cD26b9B5eecbfe3d96DAabF3d12A663DA",
  },
];

/**
 * Solana, which has no router contract to call.
 *
 * Its pool programs are the part that could not have been learned any other
 * way: on Solana the pool is a program and the collateral sits in an account
 * derived from it, so without the program ids there is nothing to derive
 * from and nothing to ask.
 */
export interface CcipSvmDeployment {
  ccipKey: string;
  selector: string;
  /** The CCIP router program. */
  router: string;
  /** Pool program ids by Chainlink's name for the pool type. */
  poolPrograms: Record<string, string>;
}

export const CCIP_SOLANA: CcipSvmDeployment | undefined = {
  ccipKey: "solana-mainnet",
  selector: "124615329519749607",
  router: "Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C",
  poolPrograms: {
    "BurnMintTokenPool": "41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB",
    "CCTPTokenPool": "CCiTPESGEevd7TBU8EGBKrcxuRq7jx3YtW6tPidnscaZ",
    "LockReleaseTokenPool": "8eqh8wppT9c5rw4ERqNCffvU6cNFJWff9WmkcYtmGiqC",
  },
};
