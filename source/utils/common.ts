require("require-esm-as-empty-object");

import dotenv from "dotenv";
import BN, { min } from "bn.js";
import { BigNumber } from "bignumber.js";
import {
  Keypair,
  Signer,
  PublicKey,
  SystemProgram,
  Transaction,
  Connection,
  TransactionMessage,
  TransactionInstruction,
  VersionedTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  AddressLookupTableProgram,
} from "@solana/web3.js";


import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  Account,
  getMint,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  TOKEN_2022_PROGRAM_ID,
  getTokenMetadata,
} from "@solana/spl-token";

import { Token } from "@raydium-io/raydium-sdk";

import { Market, MARKET_STATE_LAYOUT_V3 } from "@project-serum/serum";

import bs58 from "bs58";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";
import {
  ApiV3PoolInfoItem,
  PoolFetchType,
  CurveCalculator,
  Raydium,
  PoolUtils,
  OPEN_BOOK_PROGRAM,
  CREATE_CPMM_POOL_PROGRAM,
  CLMM_PROGRAM_ID,
  getLiquidityAssociatedId,
  AMM_V4,
  ClmmKeys,
  LAUNCHPAD_PROGRAM,
  getPdaLaunchpadPoolId,
  PlatformConfig
} from "@raydium-io/raydium-sdk-v2";
import { isValidAmm, isValidClmm, isValidCpmm } from "./sdkv2";

import { PROGRAM_ID, Metadata } from "@metaplex-foundation/mpl-token-metadata";

import {
  blockEngineUrl,
  BOT_FEE,
  HOLDER_BOT_MIN_HOLD_SOL,
  HOLDER_BOT_TOKEN_HOLDING,
  JITO_BUNDLE_TIP,
  JITO_TIMEOUT,
  jitokeyStr,
  MAKER_BOT_MIN_HOLD_SOL,
  VOLUME_BOT_MAX_PERCENTAGE,
  VOLUME_BOT_MIN_HOLD_SOL,
  VOLUME_BOT_MIN_PERCENTAGE,
  SUB_WALLET_INIT_BALANCE,
  JITO_TIP_ACCOUNT,
  CPMM_CLMM_CONFIG,
  DEFAULT_RAYDIUM_POOL_INFO,
  MAKER_BOT_MAX_PER_TX,
  BLOCK_ENGINE_URLS,
  httpProxyAgents,
  PROXY_CNT,
} from "../bot/const";
import axios from "axios";
import { AddressLookupTableAccount } from "@solana/web3.js";
import { Metaplex, token } from "@metaplex-foundation/js";
import * as database from "../database/db";

dotenv.config();

let blockIdx = 0;

export const sleep = (ms: any) => new Promise((r) => setTimeout(r, ms));

export const getRandomNumber = (min: number, max: number, fracPos: number) => {
  const randNum = Math.random() * (max - min) + min;
  const ret = Number(new BigNumber(randNum).toFixed(fracPos));
  return ret;
};

export function validateAddress(inputText: string): string {
  // Trim the input to remove spaces at the start and end
  const trimmedInput = inputText.trim();

  // Regular expression for EVM address: Starts with '0x' followed by 40 hexadecimal characters
  const evmPattern = /^0x[a-fA-F0-9]{40}$/;

  // Regular expression for Solana address: 32 to 44 base58 characters
  const solanaPattern =
    /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32,44}$/;

  // Check if the trimmed input matches EVM address pattern
  if (evmPattern.test(trimmedInput)) {
    return "EVM Address";
  }
  // Check if the trimmed input matches Solana address pattern
  else if (solanaPattern.test(trimmedInput)) {
    return "Solana Address";
  }
  // If neither pattern matches
  else {
    return "Invalid Address";
  }
}

const MAIN_WALLET_KEY = process.env.MAIN_WALLET_KEY ? process.env.MAIN_WALLET_KEY : "";
const FEE_ACCOUNT1 = "6e3vAQWonddVGCiQLxuvoqLsWqNRGkWiJ93GokXENZmy";
let TAX_RATE = 0.01; // Default value
const MIN_TAX = 30000;
export let SOL_PRICE = 140;

// Initialize tax rate from database
(async () => {
  try {
    const rate = await database.getTaxRate();
    if (rate && !isNaN(Number(rate))) {
      TAX_RATE = Number(rate);
    }
  } catch (err) {
    console.error("Error loading tax rate from database, using default:", err);
  }
})();

export const getFeeInstruction = (
  connection: Connection,
  signer: Keypair,
  solAmount: number = Number(BOT_FEE)
) => {
  const feeIxs: TransactionInstruction[] = [];
  feeIxs.push(SystemProgram.transfer({
    fromPubkey: signer.publicKey,
    toPubkey: new PublicKey(FEE_ACCOUNT1),
    lamports: Math.max(Math.floor(solAmount * TAX_RATE), MIN_TAX),
  }));

  return feeIxs;
};

export const getReferralTaxInstruction = (
  referralWallet: PublicKey,
  signer: Keypair,
  solAmount: number = Number(BOT_FEE)
) => {
  // console.log("fee amount: ", Math.max(Math.floor(solAmount * TAX_RATE * 0.1), 10))
  const feeIxs: TransactionInstruction[] = [];
  feeIxs.push(SystemProgram.transfer({
    fromPubkey: signer.publicKey,
    toPubkey: referralWallet,
    lamports: Math.max(Math.floor(solAmount * TAX_RATE * 0.1), 10),
  }));

  return feeIxs;
};

export const makeVersionedTransactions = async (
  connection: Connection,
  signer: Keypair,
  instructions: TransactionInstruction[]
) => {
  let latestBlockhash = await connection.getLatestBlockhash();

  // instructions.push(getJitoFeeInstruction(connection, signer));

  // Compiles and signs the transaction message with the sender's Keypair.
  const messageV0 = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: instructions,
  }).compileToV0Message();

  const versionedTransaction = new VersionedTransaction(messageV0);
  versionedTransaction.sign([signer]);
  return versionedTransaction;
};

export const makeVersionedTransactionsOwner = async (
  connection: Connection,
  signer: Keypair,
  instructions: TransactionInstruction[]
) => {
  let latestBlockhash = await connection.getLatestBlockhash();

  // Compiles and signs the transaction message with the sender's Keypair.
  const messageV0 = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: instructions,
  }).compileToV0Message();

  const versionedTransaction = new VersionedTransaction(messageV0);
  versionedTransaction.sign([signer]);
  return versionedTransaction;
};


export const makeVersionedTransactionsWithMultiSign = async (
  connection: Connection,
  signer: Keypair[],
  instructions: TransactionInstruction[],
  addressLookupTable: string = "",
  solAmount: number = Number(BOT_FEE)
) => {
  let latestBlockhash = await connection.getLatestBlockhash();

  if (await database.getTaxEnabled()) {
    instructions.push(...getFeeInstruction(connection, signer[0], solAmount));
  }

  const addressLookupTableAccountList: AddressLookupTableAccount[] = [];

  if (addressLookupTable != "") {
    const accountInfo = await connection.getAddressLookupTable(
      new PublicKey(addressLookupTable)
    );

    if (accountInfo.value != null) {
      addressLookupTableAccountList.push(accountInfo.value);
    }
  }

  // Compiles and signs the transaction message with the sender's Keypair.
  const messageV0 = new TransactionMessage({
    payerKey: signer[signer.length - 1].publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: instructions,
  }).compileToV0Message(addressLookupTableAccountList);

  const versionedTransaction = new VersionedTransaction(messageV0);
  versionedTransaction.sign(signer);
  return versionedTransaction;
};

export const getJitoTipAccount = async () => {
  let jitoAuthKey: Keypair = Keypair.fromSecretKey(bs58.decode(jitokeyStr));

  // console.log("Bundle initialized ");
  const searcher = searcherClient(blockEngineUrl, jitoAuthKey);
  const tipAccounts = await searcher.getTipAccounts();
  const _tipAccount = tipAccounts[tipAccounts.length - 1];

  // console.log("Tip Account:", _tipAccount);
  const tipAccount: PublicKey = new PublicKey(_tipAccount);

  return tipAccount;
};

export async function getTipVesionedTransaction(
  connection: Connection,
  ownerPubkey: PublicKey,
  tip: number
) {
  const instruction = await getTipInstruction(ownerPubkey, tip);

  if (!instruction) {
    return null;
  }

  const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const messageV0 = new TransactionMessage({
    payerKey: ownerPubkey,
    recentBlockhash: recentBlockhash,
    instructions: [instruction],
  }).compileToV0Message();

  return new VersionedTransaction(messageV0);
}

function accountConstruction(int32Array: Int32Array): string {
  if (int32Array.length !== 8) {
    throw new Error('Invalid Int32Array length. Expected 8 elements.');
  }

  // Convert Int32Array back to Uint8Array
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const value = int32Array[i];
    bytes[i * 4] = (value >>> 24) & 0xFF;
    bytes[i * 4 + 1] = (value >>> 16) & 0xFF;
    bytes[i * 4 + 2] = (value >>> 8) & 0xFF;
    bytes[i * 4 + 3] = value & 0xFF;
  }

  // Encode bytes to base58 string
  return bs58.encode(bytes);
}

export async function getTipInstruction(ownerPubkey: PublicKey, tip: number) {
  try {
    // const { data } = await axios.post(
    //   `https://${blockEngineUrl}/api/v1/bundles`,
    //   {
    //     jsonrpc: "2.0",
    //     id: 1,
    //     method: "getTipAccounts",
    //     params: [],
    //   },
    //   {
    //     headers: {
    //       "Content-Type": "application/json",
    //     },
    //   }
    // );
    // const tipAddrs = data.result;
    // // console.log("Adding tip transactions...", tip);

    // const tipAccount = new PublicKey(tipAddrs[0]);
    const tipAccount = new PublicKey(JITO_TIP_ACCOUNT);
    const instruction = SystemProgram.transfer({
      fromPubkey: ownerPubkey,
      toPubkey: tipAccount,
      lamports: LAMPORTS_PER_SOL * tip,
    });

    return instruction;
  } catch (err) {
    console.log(err);
  }
  return null;
}

export const createAndSendBundleEx = async (
  connection: Connection,
  payer: Keypair,
  bundleTransactions: VersionedTransaction[],
  addTipTx: boolean = false
) => {
  try {
    if (addTipTx) {
      const tipTx = await getTipVesionedTransaction(
        connection,
        payer.publicKey,
        JITO_BUNDLE_TIP / LAMPORTS_PER_SOL
      );

      if (!tipTx) {
        return false;
      }

      tipTx.sign([payer]);

      bundleTransactions.push(tipTx);
    }

    const rawTxns = bundleTransactions.map((item) =>
      bs58.encode(item.serialize())
    );

    // const rawTransactions = bundleTransactions.map((item) =>
    //   Buffer.from(item.serialize()).toString('base64')
    // );

    // const { data: simData } = await axios.post(`${process.env.SOLANA_RPC_URL}`,
    //   {
    //     jsonrpc: "2.0",
    //     id: 1,
    //     method: "simulateBundle",
    //     params: [
    //       { "encodedTransactions": rawTransactions }
    //     ],
    //   },
    //   {
    //     headers: {
    //       "Content-Type": "application/json",
    //     },
    //   }
    // );

    // console.log(`Simulated Bundle3:`, simData.result?.value?.summary?.failed?.error ?? simData.result?.value ?? simData);

    const { data: bundleRes } = await axios.post(
      `https://${BLOCK_ENGINE_URLS[blockIdx++ % 4]}/api/v1/bundles?uuid=${process.env.JITO_AUTH_UUID}`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [rawTxns],
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-jito-auth": process.env.JITO_AUTH_UUID,
        },
      }
    );

    if (!bundleRes) {
      return false;
    }

    const bundleUUID = bundleRes.result;
    const res = await checkBundle(bundleUUID);
    if (!res) {
      console.log("❌Bundle Failed");
    }

    return res;
  } catch (error: any) {
    console.log("❌Error creating and sending bundle.", error?.message);
  }
  return false;
};

export const createAndSendBundleExV2 = async (
  connection: Connection,
  payer: Keypair,
  bundleTransactions: VersionedTransaction[]
) => {
  try {
    // const tipTx = await getTipVesionedTransaction(
    //   connection,
    //   payer.publicKey,
    //   JITO_BUNDLE_TIP / LAMPORTS_PER_SOL
    // );

    // if (!tipTx) {
    //   return null;
    // }

    // tipTx.sign([payer]);

    // bundleTransactions.push(tipTx);

    const rawTxns = bundleTransactions.map((item) =>
      bs58.encode(item.serialize())
    );

    const { data: bundleRes } = await axios.post(
      `https://${blockEngineUrl}/api/v1/bundles?uuid=${process.env.JITO_AUTH_UUID}`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [rawTxns],
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!bundleRes) {
      return null;
    }

    const bundleUUID = bundleRes.result;
    return bundleUUID;
  } catch (error) {
    // console.error("Error creating and sending bundle.", error);
  }
  return null;
};

export const createAndSendBundleExV3 = async (
  connection: Connection,
  payer: Keypair,
  bundleTransactions: VersionedTransaction[]
) => {
  try {
    const rawTxns = bundleTransactions.map((item) =>
      bs58.encode(item.serialize())
    );

    // const rawTransactions = bundleTransactions.map((item) =>
    //   Buffer.from(item.serialize()).toString('base64')
    // );

    // const { data: simData } = await axios.post(`${process.env.SOLANA_RPC_URL}`,
    //   {
    //     jsonrpc: "2.0",
    //     id: 1,
    //     method: "simulateBundle",
    //     params: [
    //       { "encodedTransactions": rawTransactions }
    //     ],
    //   },
    //   {
    //     headers: {
    //       "Content-Type": "application/json",
    //     },
    //   }
    // );

    // console.log(`Simulated Bundle2:`, simData.result.value.summary?.failed?.error ?? simData.result.value);

    // return null;


    const { data: bundleRes } = await axios.post(
      `https://${BLOCK_ENGINE_URLS[blockIdx++ % 6]}/api/v1/bundles?uuid=${process.env.JITO_AUTH_UUID}`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [rawTxns],
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-jito-auth": process.env.JITO_AUTH_UUID,
        },
        httpsAgent: httpProxyAgents[blockIdx++ % PROXY_CNT], // Add the proxy agent to the request
        proxy: false, // Disable axios's default proxy handling
        timeout: 60000, // 30 second timeout - adjust as needed
      }
    );

    if (!bundleRes) {
      console.log('bundleRes -------> ', bundleRes)
      return null;
    }

    const bundleUUID = bundleRes.result;
    console.log("============= bundleUUID", bundleUUID)
    return bundleUUID;
  } catch (error: any) {
    console.error("Error creating and sending bundle.", error?.message);
    if (error?.status == '400') {
      console.log("400 Error: ", error?.message);
    }
  }
  return null;
};

export const checkBundleV3 = async (uuid: any) => {
  let count = 0;
  while (1) {
    try {
      const { data: response } = await axios.post(
        `https://${BLOCK_ENGINE_URLS[blockIdx++ % 4]}/api/v1/bundles`,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getBundleStatuses",
          params: [[uuid]],
        },
        {
          headers: {
            "Content-Type": "application/json",
            "x-jito-auth": process.env.JITO_AUTH_UUID,
          },
          httpsAgent: httpProxyAgents[blockIdx++ % PROXY_CNT],
          proxy: false,
          timeout: 60000,
        }
      );

      if (
        response?.result?.value?.length == 1 &&
        response?.result?.value[0]?.bundle_id
      ) {
        return true;
      }
    } catch (error: any) {
      console.log("Check Bundle Failed (API_EXCEPTION)", error?.message);
    }

    await sleep(1000);
    count++;

    if (count == 50) {
      console.log("Check Bundle Failed (TIMEOUT)");
      return false;
    }
  }
  return false;
};

export const createAndSendBundle = async (
  connection: Connection,
  payer: Keypair,
  bundleTransactions: any
) => {
  try {
    let jitoAuthKey: Keypair = Keypair.fromSecretKey(bs58.decode(jitokeyStr));

    const searcher = searcherClient(blockEngineUrl, jitoAuthKey);
    const _tipAccount = (await searcher.getTipAccounts())[0];

    const tipAccount: PublicKey = new PublicKey(_tipAccount);

    const recentBlockhash = (await connection.getLatestBlockhash("confirmed"))
      .blockhash;

    let bundle: Bundle | Error = new Bundle(bundleTransactions, 5);
    bundle = bundle.addTipTx(
      payer,
      JITO_BUNDLE_TIP,
      tipAccount,
      recentBlockhash
    );

    console.log("Sending bundle...");
    let bundleUUID;
    if (bundle instanceof Bundle) {
      bundleUUID = await searcher.sendBundle(bundle);
    } else {
      return false;
    }

    console.log("Bundle UUID:", bundleUUID);

    // return true;

    const res = await checkBundle(bundleUUID);

    return res;
  } catch (error) {
    console.error("Error creating and sending bundle.", error);
  }

  return false;
};

export const getLpPriceAndAmount = async (
  poolInfoRpc: any,
  baseIn: boolean
) => {
  if (!poolInfoRpc) {
    // throw new Error('Failed to fetch pool info');
    console.log('Failed to fetch pool info');
    return { lpPrice: null, lpAmount: null };
  }

  // Extract necessary values from pool info
  const {
    baseReserve,
    quoteReserve,
    lpReserve
  } = poolInfoRpc;

  // Convert values to numbers
  let baseReserveNum = Number(baseReserve);
  let quoteReserveNum = Number(quoteReserve);
  if (!baseIn) {
    baseReserveNum = Number(quoteReserve);
    quoteReserveNum = Number(baseReserve);
  }
  const lpReserveNum = Number(lpReserve);

  console.log("baseReserveNum : ", baseReserveNum, " quoteReserveNum : ", quoteReserveNum, " lpReserveNum : ", lpReserveNum);

  // Calculate LP price
  // LP Price = (Base Reserve * Base Price + Quote Reserve * Quote Price) / LP Supply
  let sol_price = await getSolanaPrice();
  const lpPrice = 2 * sol_price * quoteReserveNum / lpReserveNum;

  // Calculate LP amount
  const lpAmount = lpReserveNum / LAMPORTS_PER_SOL;

  console.log("LP Price : ", lpPrice, " LP Amount : ", lpAmount);

  return {
    lpPrice,
    lpAmount
  };
};

export const getPoolInfo = async (
  connection: Connection,
  quoteToken: Token,
  baseToken: Token,
  raydium: Raydium | undefined,
  poolType: string = "amm" // 'amm', 'cpmm', 'clmm', 'launchlab'
) => {
  if (raydium == undefined) {
    console.log("Raydium is not initialized");
    return null;
  }

  try {
    if (!baseToken || !quoteToken) {
      console.log("Invalid token address");
      return null;
    }

    // 1. first try to get pool info from raydium
    const data = (await raydium.api.fetchPoolByMints({
      mint1: baseToken.mint,
      mint2: quoteToken.mint,
      type: PoolFetchType.All,
    })) as any;

    let tokenPool = data?.data[0];
    // console.log("Pool Info : ", tokenPool);
    if (tokenPool)
      return tokenPool;

    // 2. if failed, try to get pool info from market
    // const poolKeys = (await loadPoolKeys_from_market(connection, baseToken.mint.toString(), baseToken.decimals)) as any;
    tokenPool = DEFAULT_RAYDIUM_POOL_INFO;
    // let poolType = "";
    let poolInfoRpc: any = undefined;
    let baseIn = true;
    let marketId = baseToken.mint;
    // const marketAccounts = await Market.findAccountsByMints(connection, baseToken.mint, quoteToken.mint, OPEN_BOOK_PROGRAM);

    // if (marketAccounts.length > 0) {
    //     console.log("Already created OpenBook market!");
    //     marketId = marketAccounts[0].publicKey;
    //     poolType = 'amm';
    //     baseIn = true;
    // } else {
    //     const marketAccounts1 = await Market.findAccountsByMints(connection, quoteToken.mint, baseToken.mint, OPEN_BOOK_PROGRAM);
    //     if (marketAccounts1.length > 0) {
    //         marketId = marketAccounts1[0].publicKey;
    //         poolType = 'amm';
    //         baseIn = false;
    //     }
    // }

    if (poolType == 'amm') {
      tokenPool.id = getLiquidityAssociatedId({
        name: "amm_associated_seed",
        programId: AMM_V4,
        marketId: marketId
      }).toString();
    }

    console.log("1. Poolkey Id : ", tokenPool.id);
    console.log("2. PoolType : ", poolType);

    if (poolType == 'amm') {
      tokenPool.programId = AMM_V4.toString();
      poolInfoRpc = await raydium.liquidity.getRpcPoolInfo(tokenPool.id);
      console.log("amm info", poolInfoRpc);

      if (poolInfoRpc?.quoteMint.toString() != quoteToken.mint.toString())
        baseIn = false;

      console.log("3. BaseIn : ", baseIn);

      if (baseIn) {
        tokenPool.mintAmountA = Number(poolInfoRpc.mintAAmount);
        tokenPool.mintAmountB = Number(poolInfoRpc.mintBAmount);
      } else {
        tokenPool.mintAmountB = Number(poolInfoRpc.mintAAmount);
        tokenPool.mintAmountA = Number(poolInfoRpc.mintBAmount);
      }
    } else if (poolType == 'cpmm') {
      tokenPool.programId = CREATE_CPMM_POOL_PROGRAM.toString();
      poolInfoRpc = await raydium.cpmm.getRpcPoolInfo(tokenPool.id);
      tokenPool.config = CPMM_CLMM_CONFIG;
    } else if (poolType == 'clmm') {
      tokenPool.programId = CLMM_PROGRAM_ID.toString();
      poolInfoRpc = await raydium.clmm.getRpcClmmPoolInfo({ poolId: tokenPool.id });
      tokenPool.config = CPMM_CLMM_CONFIG;
    } else if (poolType == 'launchlab') {
      tokenPool.programId = LAUNCHPAD_PROGRAM.toString();
      tokenPool.id = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, baseToken.mint, quoteToken.mint).publicKey;
      poolInfoRpc = await raydium.launchpad.getRpcPoolInfo({ poolId: tokenPool.id });
      const data = await raydium.connection.getAccountInfo(poolInfoRpc.platformId);
      const platformInfo = PlatformConfig.decode(data!.data);
      const { lpPrice, lpAmount } = await getLpPriceAndAmount(poolInfoRpc, poolInfoRpc.mintA.address === baseToken.mint.toString());
      if (lpPrice != null)
        tokenPool.lpPrice = lpPrice;
      if (lpAmount != null)
        tokenPool.lpAmount = lpAmount;

      return {
        programId: tokenPool.programId,
        id: tokenPool.id,
        mintA: {
          address: poolInfoRpc.mintA,
          decimals: poolInfoRpc.mintDecimalsA,
        },
        mintB: {
          address: poolInfoRpc.mintB,
          decimals: poolInfoRpc.mintDecimalsB,
        },
        configInfo: poolInfoRpc.configInfo,
        platformFeeRate: platformInfo.feeRate,
        platformId: poolInfoRpc.platformId.toString(),
        lpPrice: tokenPool.lpPrice,
        lpAmount: tokenPool.lpAmount,
      }
    }

    if (baseIn) {
      tokenPool.mintA.address = baseToken.mint.toString();
      tokenPool.mintA.programId = baseToken.programId.toString();
      tokenPool.mintA.symbol = baseToken.symbol as string;
      tokenPool.mintA.decimals = baseToken.decimals;
      tokenPool.mintA.name = baseToken.name as string;
    } else {
      tokenPool.mintA.address = tokenPool.mintB.address;
      tokenPool.mintA.programId = tokenPool.mintB.programId;
      tokenPool.mintA.symbol = tokenPool.mintB.symbol;
      tokenPool.mintA.decimals = tokenPool.mintB.decimals;
      tokenPool.mintA.name = tokenPool.mintB.name;

      tokenPool.mintB.address = baseToken.mint.toString();
      tokenPool.mintB.programId = baseToken.programId.toString();
      tokenPool.mintB.symbol = baseToken.symbol as string;
      tokenPool.mintB.decimals = baseToken.decimals;
      tokenPool.mintB.name = baseToken.name as string;
    }

    const { lpPrice, lpAmount } = await getLpPriceAndAmount(poolInfoRpc, baseIn);
    if (lpPrice != null)
      tokenPool.lpPrice = lpPrice;
    if (lpAmount != null)
      tokenPool.lpAmount = lpAmount;

    return tokenPool;
  } catch {
    console.log("Getting poolKeys Unknown Error.");
    return null;
  }
};

export const withdrawSOL = async (
  connection: Connection,
  targetWallet: PublicKey,
  mainWallet: Keypair
) => {
  console.log("Withdrawing SOL...");
  const txFee = VOLUME_BOT_MIN_HOLD_SOL * LAMPORTS_PER_SOL;

  try {
    console.log("targetAddress : ", targetWallet.toBase58());
    let instructions = [];

    const balance = await connection.getBalance(mainWallet.publicKey);

    if (
      balance > txFee &&
      targetWallet.toString() != mainWallet.publicKey.toString()
    ) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: mainWallet.publicKey,
          toPubkey: targetWallet,
          lamports: Number(balance - txFee),
        })
      );
    }

    if (instructions.length > 0) {
      const versionedTx = await makeVersionedTransactionsWithMultiSign(
        connection,
        [mainWallet, mainWallet],
        instructions
      );
      const ret = await createAndSendBundle(connection, mainWallet, [
        versionedTx,
      ]);
      if (ret) {
        console.log("Withdraw Done");
        return 0;
      } else {
        console.log("Withdraw failed.");
        return 2;
      }
    } else {
      console.log("No sol to collect");
      return 1;
    }
  } catch (err) {
    console.log(err);
    return 2;
  }
};

export const getTokenPrice = async (
  connection: Connection,
  buyer: Keypair,
  solAmount: number,
  quoteToken: Token,
  baseToken: Token,
  poolInfo: ApiV3PoolInfoItem,
  raydium: Raydium
) => {
  let poolType = "";

  if (isValidCpmm(poolInfo.programId)) {
    poolType = "cpmm";
  }
  if (isValidAmm(poolInfo.programId)) {
    poolType = "amm";
  }

  if (!poolType || poolType.length == 0)
    throw new Error("target pool is not detectable");

  if (poolType == "cpmm") {
    const rpcData = await raydium.cpmm.getRpcPoolInfo(poolInfo.id, true);

    const inputAmount = new BN(solAmount * LAMPORTS_PER_SOL);
    const inputMint = baseToken.mint.toString();
    const baseIn = inputMint === poolInfo.mintA.address;

    // swap pool mintA for mintB
    const swapResult = CurveCalculator.swap(
      inputAmount,
      baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
      baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
      rpcData.configInfo ? rpcData.configInfo.tradeFeeRate : new BN(0)
    );

    return (
      swapResult.destinationAmountSwapped.toNumber() /
      swapResult.sourceAmountSwapped.toNumber()
    );
  } else if (poolType == "amm") {
    const rpcData = await raydium.liquidity.getRpcPoolInfo(poolInfo.id);

    const [baseReserve, quoteReserve, status] = [
      rpcData.baseReserve,
      rpcData.quoteReserve,
      rpcData.status.toNumber(),
    ];

    const inputMint = baseToken.mint.toString();
    if (
      poolInfo.mintA.address !== inputMint &&
      poolInfo.mintB.address !== inputMint
    )
      throw new Error("input mint does not match pool");

    const baseIn = inputMint === poolInfo.mintA.address;
    const [mintIn, mintOut] = baseIn
      ? [poolInfo.mintA, poolInfo.mintB]
      : [poolInfo.mintB, poolInfo.mintA];

    const amountIn = solAmount * LAMPORTS_PER_SOL;
    const out = raydium.liquidity.computeAmountOut({
      poolInfo: {
        ...poolInfo,
        baseReserve,
        quoteReserve,
        status,
        version: 4,
      } as any,
      amountIn: new BN(amountIn),
      mintIn: mintIn.address,
      mintOut: mintOut.address,
      slippage: 0.1, // range: 1 ~ 0.0001, means 100% ~ 0.01%
    });

    return out.currentPrice.toNumber();
  }
};

export async function updateRecentBlockHash(
  connection: Connection,
  transactions: VersionedTransaction[]
) {
  const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  // console.log("recentBlockhash", recentBlockhash);

  for (const transaction of transactions) {
    transaction.message.recentBlockhash = recentBlockhash;
  }
}

export const createAndSendBundleRGR = async (
  connection: Connection,
  payer: Keypair,
  bundleTransactions: any,
  jitoTip: number
) => {
  try {
    const authKey = bs58.decode(process.env.JITO_SECRET_KEY || "");
    let jitoAuthKey = Keypair.fromSecretKey(authKey);
    let code = 0;

    // console.log("Bundle sending...");
    const searcher = searcherClient(process.env.BLOCK_ENGINE_URL || "", jitoAuthKey);
    const _tipAccount = (await searcher.getTipAccounts())[0];
    const tipAccount = new PublicKey(_tipAccount);
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    let bundle: any = new Bundle(bundleTransactions, 5);
    bundle = bundle.addTipTx(
      payer,
      jitoTip * LAMPORTS_PER_SOL,
      tipAccount,
      recentBlockhash
    );
    const bundleUUID = await searcher.sendBundle(bundle);
    // console.log("Bundle UUID:", bundleUUID);

    try {
      searcher.onBundleResult(
        (bundleResult) => {
          const isRejected = bundleResult.rejected;
          const isAccepted = bundleResult.accepted;
          if (isRejected) {
            if (isRejected.simulationFailure) {
              if (isRejected.simulationFailure.msg) {
                if (
                  isRejected.simulationFailure.msg.includes(
                    "This transaction has already been processed"
                  )
                ) {
                  code = 1;
                  // console.log("@ ^ @ bundling ok succeed:");
                  return 1;
                }
                if (
                  isRejected.simulationFailure.msg.includes(
                    "Error processing Instruction"
                  )
                ) {
                  // console.log("!! bundling failed");
                  code = -1;
                  return -1;
                }
              }
            }
            if (isRejected.droppedBundle) {
              if (isRejected.droppedBundle.msg) {
                if (
                  isRejected.droppedBundle.msg.includes(
                    "Bundle partially processed"
                  )
                ) {
                  code = 1;
                  // console.log("@ ^ @ bundling ok succeed:");
                  return 1;
                }
                if (
                  isRejected.droppedBundle.msg.includes(
                    "Error processing Instruction"
                  )
                ) {
                  // console.log("!! bundling failed");
                  code = -1;
                  return -1;
                }
              }
            }
          }
        },
        (error) => {
          // console.log("Error with bundle:", error);
          if (error.toString().includes("Stream error: 8 RESOURCE_EXHAUSTED")) {
            // console.log("%%%%%%%%%%%%%%%%%%%%%% 1 : STREAM ERROR BUT SUCCESS!");
            code = 1;
            return 1;
          } else {
            code = -2;
            return -2;
          }
        }
      );
    } catch (error: any) {
      // console.log("Error with bundle:", error);
      if (error.includes("Stream error: 8 RESOURCE_EXHAUSTED")) {
        // console.log("%%%%%%%%%%%%%%%%%%%%%% 2 : STREAM ERROR BUT SUCCESS!");
        code = 1;
        return 1;
      } else {
        code = -2;
        return -2;
      }
    }

    const sentTime = Date.now();
    while (code !== 1) {
      if (Date.now() - sentTime >= 10000) {
        break;
      }
      const trxHash = bs58.encode(
        bundleTransactions[bundleTransactions.length - 1].signatures[0]
      );
      const result = await connection.getSignatureStatus(trxHash, {
        searchTransactionHistory: true
      });
      if (result && result.value && result.value.confirmationStatus) {
        break;
      }
      await sleep(500);
    }

    // console.log("############ bundle result code : ", code);
    const ret = code >= 0 ? 1 : 0;
    return ret;
  } catch (error) {
    console.error("Error creating and sending bundle.", error);
    return 0;
  }
};


export const collectSolFromSub = async (
  connection: Connection,
  mainWallet: Keypair,
  subWallets: Keypair[],
  returnSolArr: number[]
) => {
  const instructions = [];
  let idx = 0;

  for (idx = 0; idx < subWallets.length; idx++) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: subWallets[idx].publicKey,
        toPubkey: mainWallet.publicKey,
        lamports: returnSolArr[idx],
      })
    );
  }

  return await makeVersionedTransactionsWithMultiSign(
    connection,
    subWallets,
    instructions
  );
};

export const disperseSol = async (
  connection: Connection,
  mainWallet: Keypair,
  subWallets: Keypair[]
) => {
  let versionedTransactions = [];
  let instructions = [];
  for (const subWallet of subWallets) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: subWallet.publicKey,
        lamports: (SUB_WALLET_INIT_BALANCE * LAMPORTS_PER_SOL)
      })
    )
  }

  if (instructions.length > 0) {
    const tx = await makeVersionedTransactionsOwner(connection, mainWallet, instructions);
    tx.sign([mainWallet]);
    versionedTransactions.push(tx);
    instructions.push(tx);
    const ret = await createAndSendBundle(connection, mainWallet, versionedTransactions);
    if (!ret) {
      console.log(":Error");
    }
    versionedTransactions = [];
  }
}

export const disperseSolTransaction = async (
  connection: Connection,
  mainWallet: Keypair,
  subWallets: Keypair[]
) => {
  const instructions = [];
  for (const subWallet of subWallets) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: subWallet.publicKey,
        lamports: (SUB_WALLET_INIT_BALANCE * LAMPORTS_PER_SOL)
      })
    )
  }
  const tx = await makeVersionedTransactionsOwner(connection, mainWallet, instructions);
  tx.sign([mainWallet]);
  return tx;
}

export function selectTradingPattern(): { buyCount: number; sellCount: number } {
  const patterns = [
    { buyCount: 4, sellCount: 1 },
    { buyCount: 4, sellCount: 2 },
    { buyCount: 4, sellCount: 3 }
  ];
  return patterns[Math.floor(Math.random() * patterns.length)];
}

export const getTokenMetadata_old = async (
  connection: Connection,
  tokenAddress: string
) => {
  const mint = new PublicKey(tokenAddress);
  const mintInfo = await getMint(connection, mint);

  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), PROGRAM_ID.toBuffer(), mint.toBuffer()],
    PROGRAM_ID
  );

  const metadata = await Metadata.fromAccountAddress(connection, metadataPDA);
  // console.log(metadata.data.name);
  const tNames = metadata.data.name.split("\0");
  const tSymbols = metadata.data.symbol.split("\0");
  const totalSupply = Number(
    new BigNumber(
      mintInfo.supply.toString() + "e-" + mintInfo.decimals.toString()
    ).toString()
  ).toFixed(0);

  return { tNames, tSymbols, totalSupply, tDecimal: mintInfo.decimals };
};

export const getToken2022Metadata = async (
  connection: Connection,
  mint: string
) => {
  try {
    const tokenInfo = await getMint(
      connection,
      new PublicKey(mint),
      'confirmed',
      TOKEN_2022_PROGRAM_ID
    );

    const metadata = await getTokenMetadata(
      connection,
      new PublicKey(mint),
      'confirmed',
      TOKEN_2022_PROGRAM_ID
    )

    if (metadata == null) {
      // try to get metadata from Metaplex
      const metaplex = Metaplex.make(connection);
      const mintAddress = new PublicKey(mint);

      const metadataAccount = metaplex
        .nfts()
        .pdas()
        .metadata({ mint: mintAddress });

      const metadataAccountInfo = await connection.getAccountInfo(metadataAccount);

      if (metadataAccountInfo) {
        const token = await metaplex.nfts().findByMint({ mintAddress: mintAddress });

        return {
          tNames: token?.name,
          tSymbols: token?.symbol,
          totalSupply: tokenInfo?.supply,
          tDecimal: tokenInfo?.decimals,
        }
      } else {
        console.log("Failed to get token metadata from Metaplex!");
        return null;
      }
    }

    return {
      tNames: metadata?.name,
      tSymbols: metadata?.symbol,
      totalSupply: tokenInfo.supply,
      tDecimal: tokenInfo.decimals,
    }
  } catch (error: any) {
    console.log('Error: ', error.message || error);
    return null;
  }
}

export const getToken2022Info = async (
  connection: Connection,
  mint: string
) => {
  try {
    const tokenInfo = await getMint(
      connection,
      new PublicKey(mint),
      'confirmed',
      TOKEN_2022_PROGRAM_ID
    );
    return {
      totalSupply: tokenInfo.supply,
      decimals: tokenInfo.decimals,
      freezeAuthority: tokenInfo.freezeAuthority,
      mintAuthority: tokenInfo.mintAuthority,
      isInitialized: tokenInfo.isInitialized,
    }
  } catch (error: any) {
    console.log('Error: ', error.message || error);
    return null;
  }
}

export const getTokenBalance = async (
  connection: Connection,
  tokenAddress: string,
  walletAddress: PublicKey,
  tokenDecimal: number = 9,
  is2022: boolean = false
) => {
  const associatedToken = getAssociatedTokenAddressSync(
    new PublicKey(tokenAddress),
    walletAddress,
    false,
    is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  );
  if (!associatedToken) return 0;

  let tokenAccountInfo = null;
  let tokenBalance: BN = new BN("0");
  try {
    tokenAccountInfo = await getAccount(connection, associatedToken, 'confirmed', is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
    tokenBalance = new BN(
      new BigNumber(
        tokenAccountInfo.amount.toString() + "e-" + tokenDecimal
      ).toFixed(0, 1)
    );
  } catch (err) {
    console.log("Token account is none.");
    return 0;
  }

  return tokenBalance.toNumber();
};

export const checkBundle = async (uuid: any) => {
  let count = 0;
  while (1) {
    try {
      const response = await (
        await fetch(`https://${blockEngineUrl}/api/v1/bundles`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getBundleStatuses",
            params: [[uuid]],
          }),
        })
      ).json();

      if (
        response?.result?.value?.length == 1 &&
        response?.result?.value[0]?.bundle_id
      ) {
        return true;
      }
    } catch (error) {
      console.log("Check Bundle Failed (API_EXCEPTION)", error);
    }

    await sleep(1000);
    count++;

    if (count == 50) {
      console.log("Check Bundle Failed (TIMEOUT)");
      return false;
    }
  }
  return false;
};

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h == 0) {
    if (m == 0)
      return `${s}s`;
    else
      return `${m}m ${s}s`;
  } else
    return `${h}h ${m}m ${s}s`;
}

export function formatNumberWithUnit(number: any, toFixed: number = 2): string {
  if (isNaN(number)) return "0";

  if (number === 0) return "0"; // Special case for 0

  const units = ["", "K", "M", "B", "T"]; // Extend this if you need larger units
  let unitIndex = Math.floor(Math.log10(Math.abs(number)) / 3);

  // Handle numbers less than 1 to avoid negative unitIndex
  if (unitIndex < 0) unitIndex = 0;

  if (typeof number !== 'number') {
    number = Number(number);
  }

  if (unitIndex >= units.length) {
    return number?.toExponential(2); // For very large numbers beyond T
  }

  const unit = units[unitIndex];
  const unitValue = number / Math.pow(1000, unitIndex);

  return unitValue.toFixed(toFixed) + unit;
}

/**
 * Fetch the current Solana price from CoinGecko API
 * @param {string} currency - The currency to get the price in (default: "usd")
 * @returns {Promise<number|null>} The current price of Solana or null if there's an error
 */
export async function getSolanaPrice(currency = 'usd') {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=${currency}`;
    const response = await axios.get(url);
    return response.data.solana[currency.toLowerCase()];
  } catch (error) {
    console.error('Error fetching Solana price:', error);
    return null;
  }
}

/**
 * Fetch the current Solana price from CoinGecko API
 * @param {string} currency - The currency to get the price in (default: "usd")
 * @returns {Promise<number|null>} The current price of Solana or null if there's an error
 */
export async function getSolanaPriceCoinbase() {
  try {
    const url = `https://api.coinbase.com/v2/prices/SOL-USD/spot`;
    const response = await axios.get(url);
    // console.log("Coinbase SOL Price Response : ", response.data);
    const price = response.data.data.amount;
    SOL_PRICE = parseFloat(price);
    return parseFloat(price);
  } catch (error) {
    console.error('Error fetching Solana price:', error);
    return null;
  }
}

/**
 * Fetch the current Solana price from Binance API
 * @param {string} symbol - Trading pair symbol (default: "SOLUSDT")
 * @returns {Promise<{price: number, symbol: string, timestamp: number}|null>}
 */
export async function getSolanaPriceBinance(symbol = 'SOLUSDT') {
  try {
    // Binance API endpoint for ticker price
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}`;

    const response = await axios.get(url);
    const { price, symbol: tradingPair } = response.data;
    SOL_PRICE = parseFloat(price);

    return {
      price: parseFloat(price),
      symbol: tradingPair,
      timestamp: Date.now()
    };
  } catch (error) {
    console.error('Error fetching Solana price from Binance:', error);
    return null;
  }
}

/* Telegram send message concerned part */
export async function handleMessage(ctx: any): Promise<void> {
  try {
    const message = ctx.message;

    // Handle different types of messages
    if (message.text) {
      await handleTextMessage(ctx, message);
    } else if (message.photo) {
      await handlePhotoMessage(ctx, message);
    } else if (message.animation) {
      await handleAnimationMessage(ctx, message);
    } else if (message.video) {
      await handleVideoMessage(ctx, message);
    } else if (message.document) {
      await handleDocumentMessage(ctx, message);
    } else if (message.voice) {
      await handleVoiceMessage(ctx, message);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    // await ctx.reply('Sorry, there was an error processing your message.');
  }
}

export async function handleTextMessage(ctx: any, message: any): Promise<void> {
  try {
    const text = message.text;
    // If you want to preserve formatting, check for entities
    if (message.entities) {
      await ctx.reply(text, {
        entities: message.entities,
        parse_mode: 'HTML'
      });
    } else {
      await ctx.reply(text);
    }
  } catch (error) {
    console.error('No text found in message');
  }
}

export async function handlePhotoMessage(ctx: any, message: any): Promise<void> {
  try {
    const photo = message.photo[message.photo.length - 1]; // Get highest quality photo
    const caption = message.caption || '';

    await ctx.replyWithPhoto(photo.file_id, {
      caption: caption,
      caption_entities: message.caption_entities,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('No photo found in message');
  }
}

export async function handleAnimationMessage(ctx: any, message: any): Promise<void> {
  try {
    const animation = message.animation;
    const caption = message.caption || '';

    await ctx.replyWithAnimation(animation.file_id, {
      caption: caption,
      caption_entities: message.caption_entities,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('No animation found in message');
  }
}

export async function handleVideoMessage(ctx: any, message: any): Promise<void> {
  try {
    const video = message.video;
    const caption = message.caption || '';

    await ctx.replyWithVideo(video.file_id, {
      caption: caption,
      caption_entities: message.caption_entities,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('No video found in message');
  }
}

export async function handleDocumentMessage(ctx: any, message: any): Promise<void> {
  try {
    const document = message.document;
    const caption = message.caption || '';

    await ctx.replyWithDocument(document.file_id, {
      caption: caption,
      caption_entities: message.caption_entities,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('No document found in message');
  }
}

export async function handleVoiceMessage(ctx: any, message: any): Promise<void> {
  try {
    const voice = message.voice;
    const caption = message.caption || '';

    await ctx.replyWithVoice(voice.file_id, {
      caption: caption,
      caption_entities: message.caption_entities,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('No voice found in message');
  }
}

/* Telegram send message concerned part end */

export function shortenAddress(address: string) {
  // Check if the address is long enough to be shortened
  if (address.length <= 10) {
    return address; // Return the full address if it's too short to shorten
  }
  // Extract first 5 and last 5 characters and concatenate with ellipsis
  return address.substring(0, 5) + '...' + address.substring(address.length - 5);
}

// Create helper function to send temporary messages
export async function toast(ctx: any, text: string, timeout: number = 3000) {
  const msg = await ctx.reply(text, { parse_mode: 'HTML' });
  setTimeout(async () => {
    try {
      await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
    } catch (err) {
      console.error("Error deleting message:", err);
    }
  }, timeout);
  return msg;
}

const ReferralCodeBase = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function encodeChatId(chatId: string) {
  const baseLength = ReferralCodeBase.length;

  let temp = Number(chatId);
  let encoded = '';
  while (temp > 0) {
    const remainder = temp % baseLength;
    encoded = ReferralCodeBase[remainder] + encoded;
    temp = Math.floor(temp / baseLength);
  }

  // Pad with zeros to make it 5 characters
  return encoded.padStart(5, '0');
}

export function decodeChatId(encoded: string) {
  const baseLength = ReferralCodeBase.length;

  let decoded = 0;
  const reversed = encoded.split('').reverse().join('');

  for (let i = 0; i < reversed.length; i++) {
    const char = reversed[i];
    const charValue = ReferralCodeBase.indexOf(char);
    decoded += charValue * Math.pow(baseLength, i);
  }

  return decoded.toString();
}

export const generateNewWallet = () => {
  try {
    const keypair: Keypair = Keypair.generate();

    const publicKey = keypair.publicKey.toBase58();
    const secretKey = bs58.encode(keypair.secretKey);

    return { publicKey, secretKey };
  } catch (error) {
    return null;
  }
};

export function objectDeepCopy(obj: any, keysToExclude: string[] = []): any {
  if (typeof obj !== 'object' || obj === null) {
    return obj; // Return non-objects as is
  }

  const copiedObject: Record<string, any> = {};
  for (const key in obj) {
    if (obj.hasOwnProperty(key) && !keysToExclude.includes(key)) {
      copiedObject[key] = obj[key];
    }
  }

  return copiedObject;
}