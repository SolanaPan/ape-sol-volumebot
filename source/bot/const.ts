import dotenv from "dotenv";
import { Token, TOKEN_PROGRAM_ID } from "@raydium-io/raydium-sdk";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { HttpsProxyAgent } from "https-proxy-agent";

dotenv.config();

export const networkName = process.env.SOLANA_RPC_URL || "mainnet";
export const networkName2 = process.env.SOLANA_RPC_URL2 || "mainnet";
console.log("RPC:", networkName);

export const connection = new Connection(networkName, "finalized");
export const connection2 = new Connection(networkName2, "processed");

export const raydiumSDKList = new Map<string, Raydium>();

export const ONE_K_VOL_PRICE = process.env.ONE_K_VOL_PRICE ? parseFloat(process.env.ONE_K_VOL_PRICE) : 0.18;
export const MAKER_INTERVAL = process.env.VOLUME_MAKER_INTERVAL_SPAN || 30;

export const VOLUME_BOT_MIN_PERCENTAGE = process.env.VOLUME_BOT_MIN_PERCENTAGE ? parseFloat(process.env.VOLUME_BOT_MIN_PERCENTAGE) : 0.8;
export const VOLUME_BOT_MAX_PERCENTAGE = process.env.VOLUME_BOT_MAX_PERCENTAGE ? parseFloat(process.env.VOLUME_BOT_MAX_PERCENTAGE) : 0.9;

export const TARGET_VOLUME_MIN = 10000;
export const TARGET_VOLUME_MAX = 1000000000;

export const TARGET_MAKER_MIN = 1000;
export const TARGET_MAKER_MAX = 10000000;

export const TARGET_HOLDER_MIN = 100;
export const TARGET_HOLDER_MAX = 100000;

export const MAX_WALLET_COUNT = process.env.MAX_WALLET_COUNT ? parseInt(process.env.MAX_WALLET_COUNT) : 1000;
export const HOLDER_BOT_TOKEN_HOLDING = process.env.HOLDER_BOT_TOKEN_HOLDING ? parseInt(process.env.HOLDER_BOT_TOKEN_HOLDING) : 11;
export const HOLDER_BOT_MIN_HOLD_SOL = 0.003;
export const MAKER_BOT_MAX_PER_TX = process.env.MAKER_BOT_MAX_PER_TX ? parseInt(process.env.MAKER_BOT_MAX_PER_TX) : 4;
export const MAKER_BOT_MIN_HOLD_SOL = 0.005;
export const VOLUME_BOT_MIN_HOLD_SOL = process.env.VOLUME_BOT_MIN_HOLD_SOL ? parseFloat(process.env.VOLUME_BOT_MIN_HOLD_SOL) : 0.01;
export const UNIT_SUBWALLET_NUM = process.env.UNIT_SUBWALLET_NUM ? parseInt(process.env.UNIT_SUBWALLET_NUM) : 10;
export const BOT_FEE = process.env.BOT_FEE ? parseFloat(process.env.BOT_FEE) : 1;
export const SUB_WALLET_INIT_BALANCE = process.env.SUB_WALLET_INIT_BALANCE ? parseFloat(process.env.SUB_WALLET_INIT_BALANCE) : 0.001;
export const jitokeyStr: any = process.env.JITO_SECRET_KEY;
export const blockEngineUrl: any = process.env.BLOCK_ENGINE_URL;
export const JITO_BUNDLE_TIP: number = process.env.JITO_BUNDLE_TIP ? parseFloat(process.env.JITO_BUNDLE_TIP) * LAMPORTS_PER_SOL : 50000;

export const MIN_DEPOSIT_SOL = process.env.MIN_DEPOSIT_SOL ? parseFloat(process.env.MIN_DEPOSIT_SOL) : 1.2;
export const MIN_REMAIN_SOL = process.env.MIN_REMAIN_SOL ? parseFloat(process.env.MIN_REMAIN_SOL) : 0.1;

export const MAX_BUNDLE_FAILED_COUNT = 3;

export const ADMIN_USERS = process.env.ADMIN_USER ? process.env.ADMIN_USER.split(',').map(user => Number(user.trim())) : [8267607372];
export const MAX_USER_COUNT: number = process.env.MAX_USER_COUNT ? parseInt(process.env.MAX_USER_COUNT) : 5;

export const BONUS_WALLET: string = process.env.BONUS_WALLET || "";
export const BONUS_THRESHOLD: number = process.env.BONUS_THRESHOLD ? parseInt(process.env.BONUS_THRESHOLD) : 100000;

export const token = process.env.BOT_TOKEN;
export const JITO_TIMEOUT = 30;
export const JITO_TIP_ACCOUNT = "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt";
export const BONUS_AMOUNT = 5000;
export const ADMIN_CHANNEL = -1003366147098;

export const splStartStopNotifies = new Set<number>();
export const GenerateNewWallets = new Set<number>();

export const replyMsgCache = new Map<any, any>();

export const DelayNotifies = new Set<number>();
export const MaxBuyNotifies = new Set<number>();
export const promoTextNotifies = new Set<number>();
export const promoCodeNotifies = new Set<number>();
export const testDMNotifies = new Set<number>();
export const sendDMNotifies = new Set<number>();
export const oneKVolPriceNotifies = new Set<number>();
export const taxRateNotifies = new Set<number>();
export const withdrawNotifies = new Set<number>();
export const importWalletNotifies = new Set<number>();
export const targetAmountNotifies = new Set<number>();

export const maxTxNotifies = new Set<number>();
export const mmAmountNotifies = new Set<number>();
export const collectSolNotifies = new Set<number>();
export const pendingCollectSol = new Set<number>();
export const pendingTokenBuy = new Set<number>();

export const prvDMUserNotifies = new Set<number>();
export const prvDMTextNotifies = new Set<number>();
export const prvDMUserIds = new Map<number, string>();

export const holderBots = new Map<any, boolean>();
export const makerBots = new Map<any, boolean>();
export const volumeBots = new Map<any, boolean>();

export const lastBotMessage = new Map<number, any>();

export const paycheckTimerIds = new Map<number, any>();

export const BOT_STATUS = {
  NOT_STARTED: 0,
  ARCHIVED_TARGET_VOLUME: 1,
  RUNNING: 2,
  STOPPED_BY_USER: 3,
  STOPPED_DUE_TO_MAIN_WALLET_BALANCE: 4,
  STOPPED_DUE_TO_SUB_WALLETS_BALANCE: 5,
  STOPPED_DUE_TO_OTHER_ERROR: 6,
  STOPPED_DUE_TO_SIMULATION_ERROR: 7,
  STOPPED_DUE_TO_MANUAL_STOP: 8,
  ARCHIVED_TARGET: 9,
};

export const quoteToken = new Token(
  TOKEN_PROGRAM_ID,
  "So11111111111111111111111111111111111111112",
  9,
  "WSOL",
  "WSOL"
);

export const resetNotifies = (id: any) => {
  MaxBuyNotifies.delete(id);
  DelayNotifies.delete(id);
  promoCodeNotifies.delete(id);
  promoTextNotifies.delete(id);

  oneKVolPriceNotifies.delete(id);
  taxRateNotifies.delete(id);
  mmAmountNotifies.delete(id);
  splStartStopNotifies.delete(id);
  collectSolNotifies.delete(id);

  prvDMUserNotifies.delete(id);
  prvDMTextNotifies.delete(id);

  withdrawNotifies.delete(id);
  importWalletNotifies.delete(id);
}

export const DEFAULT_RAYDIUM_POOL_INFO = {
  type: 'Standard',
  programId: '',
  id: '',
  mintA: {
    chainId: 101,
    address: '',
    programId: '',
    logoURI: '',
    symbol: '',
    name: '',
    decimals: 9,
    tags: [],
    extensions: {}
  },
  mintB: {
    chainId: 101,
    address: 'So11111111111111111111111111111111111111112',
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    logoURI: 'https://img-v1.raydium.io/icon/So11111111111111111111111111111111111111112.png',
    symbol: 'WSOL',
    name: 'Wrapped SOL',
    decimals: 9,
    tags: [],
    extensions: {}
  },
  config: {
    id: 'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2',
    index: 0,
    protocolFeeRate: 120000,
    tradeFeeRate: 2500,
    fundFeeRate: 40000,
    createPoolFee: '150000000'
  },
  price: 0,
  mintAmountA: 0,
  mintAmountB: 0,
  feeRate: 0,
  openTime: '0',
  tvl: 0,
  day: {
    volume: 0,
    volumeQuote: 0,
    volumeFee: 0,
    apr: 0,
    feeApr: 0,
    priceMin: 0,
    priceMax: 0,
    rewardApr: []
  },
  week: {
    volume: 0,
    volumeQuote: 0,
    volumeFee: 0,
    apr: 0,
    feeApr: 0,
    priceMin: 0,
    priceMax: 0,
    rewardApr: []
  },
  month: {
    volume: 0,
    volumeQuote: 0,
    volumeFee: 0,
    apr: 0,
    feeApr: 0,
    priceMin: 0,
    priceMax: 0,
    rewardApr: []
  },
  pooltype: ['OpenBookMarket'],
  rewardDefaultInfos: [],
  farmUpcomingCount: 0,
  farmOngoingCount: 0,
  farmFinishedCount: 0,
  marketId: '',
  lpMint: {
    chainId: 101,
    address: '',
    programId: '',
    logoURI: '',
    symbol: '',
    name: '',
    decimals: 9,
    tags: [],
    extensions: {}
  },
  lpPrice: 0,
  lpAmount: 0,
  burnPercent: 0
};

export const CPMM_CLMM_CONFIG = {
  id: 'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2',
  index: 0,
  protocolFeeRate: 120000,
  tradeFeeRate: 2500,
  fundFeeRate: 40000,
  createPoolFee: '150000000'
};

export const BLOCK_ENGINE_URLS = [
  "frankfurt.mainnet.block-engine.jito.wtf",
  "amsterdam.mainnet.block-engine.jito.wtf",
  "london.mainnet.block-engine.jito.wtf",
  "ny.mainnet.block-engine.jito.wtf",
  "tokyo.mainnet.block-engine.jito.wtf",
  "slc.mainnet.block-engine.jito.wtf",
  "singapore.mainnet.block-engine.jito.wtf",
];

// List of proxies
const proxyList = [
  // "45.11.152.207:12323:14ae5949afb25:441a43e783",
  // "192.140.3.136:12323:14ae5949afb25:441a43e783",
  // "185.155.221.212:12323:14ae5949afb25:441a43e783",
  // "45.11.153.101:12323:14ae5949afb25:441a43e783",
  // "5.181.36.253:12323:14ae5949afb25:441a43e783",
  // "192.146.138.72:12323:14a04a35fcfe2:58d90d380b",
  // "45.11.153.39:12323:14a04a35fcfe2:58d90d380b",
  // "45.11.152.244:12323:14a04a35fcfe2:58d90d380b",
  // "45.81.240.167:12323:14a04a35fcfe2:58d90d380b",
  // "192.140.3.145:12323:14a04a35fcfe2:58d90d380b",
  // "5.181.37.234:12323:14a04a35fcfe2:58d90d380b",
  // "147.78.198.127:12323:14a04a35fcfe2:58d90d380b",
  "185.168.249.220:8000:pRRLME:vTSKG9",
  "185.168.249.115:8000:pRRLME:vTSKG9",
  "185.168.249.237:8000:pRRLME:vTSKG9",
  "45.130.130.119:8000:pRRLME:vTSKG9",
  "45.130.129.248:8000:pRRLME:vTSKG9",
  "194.33.32.100:8000:pRRLME:vTSKG9",
  "163.198.215.18:8000:pRRLME:vTSKG9",
  "168.81.66.249:8000:pRRLME:vTSKG9",
  "168.81.65.165:8000:pRRLME:vTSKG9",
  "168.81.66.197:8000:pRRLME:vTSKG9",
  "168.81.64.23:8000:pRRLME:vTSKG9",
  "168.81.66.91:8000:pRRLME:vTSKG9",
  "168.81.64.61:8000:pRRLME:vTSKG9",
  "168.81.67.31:8000:pRRLME:vTSKG9",
  "168.81.64.130:8000:pRRLME:vTSKG9",
  "168.81.67.208:8000:pRRLME:vTSKG9",
  "168.81.66.188:8000:pRRLME:vTSKG9",
  "168.81.65.195:8000:pRRLME:vTSKG9",
  "168.81.67.39:8000:pRRLME:vTSKG9",
  "168.81.67.61:8000:pRRLME:vTSKG9",
  "168.81.67.19:8000:pRRLME:vTSKG9",
  "168.80.201.65:8000:pRRLME:vTSKG9",
  "168.80.200.8:8000:pRRLME:vTSKG9",
  "168.80.200.58:8000:pRRLME:vTSKG9",
  "168.80.200.71:8000:pRRLME:vTSKG9",
  "168.80.201.86:8000:pRRLME:vTSKG9",
  "168.80.203.167:8000:pRRLME:vTSKG9",
  "168.80.200.207:8000:pRRLME:vTSKG9",
  "168.80.200.221:8000:pRRLME:vTSKG9",
  "168.80.201.33:8000:pRRLME:vTSKG9",
  "163.198.213.40:8000:25PzHB:ZJkYcd",
  "163.198.212.156:8000:25PzHB:ZJkYcd",
  "163.198.214.187:8000:25PzHB:ZJkYcd",
  "163.198.215.240:8000:25PzHB:ZJkYcd",
  "163.198.212.33:8000:25PzHB:ZJkYcd",
  "163.198.215.165:8000:25PzHB:ZJkYcd",
  "163.198.215.30:8000:25PzHB:ZJkYcd",
  "163.198.212.166:8000:25PzHB:ZJkYcd",
  "163.198.214.247:8000:25PzHB:ZJkYcd",
  "163.198.214.152:8000:25PzHB:ZJkYcd",
  "163.198.213.135:8000:25PzHB:ZJkYcd",
  "163.198.214.237:8000:25PzHB:ZJkYcd",
  "163.198.214.243:8000:25PzHB:ZJkYcd",
  "163.198.213.215:8000:25PzHB:ZJkYcd",
  "163.198.215.75:8000:25PzHB:ZJkYcd",
  "163.198.214.23:8000:25PzHB:ZJkYcd",
  "163.198.212.21:8000:25PzHB:ZJkYcd",
  "163.198.212.112:8000:25PzHB:ZJkYcd",
  "163.198.215.71:8000:25PzHB:ZJkYcd",
  "163.198.215.128:8000:25PzHB:ZJkYcd",
  "163.198.213.221:8000:25PzHB:ZJkYcd",
  "168.80.81.5:8000:25PzHB:ZJkYcd",
  "168.80.81.98:8000:25PzHB:ZJkYcd",
  "168.80.81.137:8000:25PzHB:ZJkYcd",
  "168.81.66.65:8000:25PzHB:ZJkYcd",
  "168.81.67.131:8000:25PzHB:ZJkYcd",
  "168.81.66.29:8000:25PzHB:ZJkYcd",
  "168.81.64.188:8000:25PzHB:ZJkYcd",
  "168.81.64.191:8000:25PzHB:ZJkYcd",
  "168.81.67.77:8000:25PzHB:ZJkYcd",
  // "geo.iproyal.com:12321:TFBA1suqLnnz3roE:nfE9G1q0kWYr0sNv_country-nl_streaming-1"
];

export const httpProxyAgents = proxyList.map((proxy) => {
  const [proxyHost, proxyPort, proxyUser, proxyPass] = proxy.split(':');
  const proxyUrl = `http://${proxyUser}:${proxyPass}@${proxyHost}:${proxyPort}`;
  return new HttpsProxyAgent(proxyUrl);
});

export const PROXY_CNT = httpProxyAgents.length;