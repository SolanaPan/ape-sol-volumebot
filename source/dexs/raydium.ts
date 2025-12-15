require("require-esm-as-empty-object");

import dotenv from "dotenv";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
  LAMPORTS_PER_SOL,
  AddressLookupTableProgram,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

import {
  Token,
  TxVersion,
} from "@raydium-io/raydium-sdk";

import {
  ApiV3PoolInfoItem,
  CurveCalculator,
  Raydium,
  PoolUtils,
  Curve,
  add,
} from "@raydium-io/raydium-sdk-v2";
import { isValidAmm, isValidClmm, isValidCpmm, isValidLaunchpad } from "../utils/sdkv2";

import {
  JITO_BUNDLE_TIP,
  MAKER_BOT_MAX_PER_TX,
} from "../bot/const";
import { createAndSendBundleEx, getRandomNumber, getTipInstruction, getTokenBalance, makeVersionedTransactions, makeVersionedTransactionsWithMultiSign } from "../utils/common";
import { addRaydiumSDK } from "../bot";

dotenv.config();

export const sleep = (ms: any) => new Promise((r) => setTimeout(r, ms));

export const createTokenAccountTxRaydium = async (
  connection: Connection,
  mainWallet: Keypair,
  mint: PublicKey,
  poolInfo: any,
  raydium: Raydium | undefined,
  is2022: boolean = false
) => {
  if (raydium == undefined) {
    return null;
  }

  const instructions = [];
  let idx = 0;

  const associatedToken = getAssociatedTokenAddressSync(
    mint,
    mainWallet.publicKey,
    false,
    is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  );

  const info = await connection.getAccountInfo(associatedToken);

  if (!info) {
    console.log("*********** creating raydium ATA...", idx);
    instructions.push(
      createAssociatedTokenAccountInstruction(
        mainWallet.publicKey,
        associatedToken,
        mainWallet.publicKey,
        mint,
        is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
      )
    );
  }

  console.log("*********** creating addressLookupTable...", idx);

  let poolType = "",
    poolKeys;
  const addressList = [];

  if (isValidCpmm(poolInfo.programId)) {
    poolType = "cpmm";
  } else if (isValidAmm(poolInfo.programId)) {
    poolType = "amm";
  } else if (isValidClmm(poolInfo.programId)) {
    poolType = "clmm";
  } else if (isValidLaunchpad(poolInfo.programId)) {
    poolType = "launchlab";
  }

  if (poolType == "cpmm") {
    poolKeys = await raydium.cpmm.getCpmmPoolKeys(poolInfo.id);
    // console.log("========= cpmm ===========", poolKeys);

    addressList.push(poolKeys.authority);
    addressList.push(poolKeys.id);
    addressList.push(poolKeys.mintA.address);
    addressList.push(poolKeys.mintA.programId);
    addressList.push(poolKeys.mintB.address);
    addressList.push(poolKeys.mintB.programId);
    addressList.push(poolKeys.mintLp.address);
    addressList.push(poolKeys.mintLp.programId);
    addressList.push(poolKeys.programId);
    addressList.push(poolKeys.vault.A);
    addressList.push(poolKeys.vault.B);
  } else if (poolType == "clmm") {
    poolKeys = await raydium.clmm.getClmmPoolKeys(poolInfo.id);

    addressList.push(poolKeys.id);
    addressList.push(poolKeys.mintA.address);
    addressList.push(poolKeys.mintA.programId);
    addressList.push(poolKeys.mintB.address);
    addressList.push(poolKeys.mintB.programId);
    addressList.push(poolKeys.programId);
    addressList.push(poolKeys.vault.A);
    addressList.push(poolKeys.vault.B);
  } else if (poolType == "amm") {
    poolKeys = await raydium.liquidity.getAmmPoolKeys(poolInfo.id);

    addressList.push(poolKeys.programId);
    addressList.push(poolKeys.id);
    addressList.push(poolKeys.mintA.address);
    addressList.push(poolKeys.mintA.programId);
    addressList.push(poolKeys.mintB.address);
    addressList.push(poolKeys.mintB.programId);
    addressList.push(poolKeys.vault.A);
    addressList.push(poolKeys.vault.B);
    addressList.push(poolKeys.authority);
    addressList.push(poolKeys.openOrders);
    addressList.push(poolKeys.targetOrders);
    addressList.push(poolKeys.mintLp.address);
    addressList.push(poolKeys.mintLp.programId);
    addressList.push(poolKeys.marketProgramId);
    addressList.push(poolKeys.marketId);
    addressList.push(poolKeys.marketAuthority);
    addressList.push(poolKeys.marketBaseVault);
    addressList.push(poolKeys.marketQuoteVault);
    addressList.push(poolKeys.marketBids);
    addressList.push(poolKeys.marketAsks);
    addressList.push(poolKeys.marketEventQueue);
  } else if (poolType == "launchlab") {
    addressList.push(poolInfo.programId);
    addressList.push(poolInfo.id);
    addressList.push(poolInfo.mintA.address);
    addressList.push(poolInfo.mintB.address);
    addressList.push(poolInfo.platformId);
  }

  // console.log("here", poolKeys);

  // const slot = await connection.getSlot();
  const currentSlot = await connection.getSlot();
  const startSlot = currentSlot - 200;
  const slots = await connection.getBlocks(startSlot, currentSlot);
  if (slots.length < 100) {
    throw new Error(
      `Could find only ${slots.length} slots on the main fork`
    );
  }

  const [lookupTableInst, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: mainWallet.publicKey,
      payer: mainWallet.publicKey,
      recentSlot: slots[9],
    });

  const extendInstruction = AddressLookupTableProgram.extendLookupTable({
    payer: mainWallet.publicKey,
    authority: mainWallet.publicKey,
    lookupTable: lookupTableAddress,
    addresses: addressList.map((item) => new PublicKey(item)),
  });

  instructions.push(lookupTableInst);
  instructions.push(extendInstruction);

  // add jito tip instruction
  const jitoTipIx = await getTipInstruction(
    mainWallet.publicKey,
    JITO_BUNDLE_TIP / LAMPORTS_PER_SOL
  );
  if (!jitoTipIx) {
    throw new Error("Failed to get Jito tip instruction");
  }
  instructions.push(jitoTipIx);

  const tx = await makeVersionedTransactions(
    connection,
    mainWallet,
    instructions
  );

  // const sim = await connection.simulateTransaction(tx);
  // console.log("sim : ", sim);

  const ret = await createAndSendBundleEx(connection, mainWallet, [tx]);
  console.log("[raydium] Create tokenAccount & addressLookupTable : ", ret, lookupTableAddress.toBase58());
  if (ret) {
    await sleep(25000);
    return lookupTableAddress;
  }
  else return "";
};

export const makeBuySellTransactionRaydiumVolume = async (
  connection: Connection,
  payer: Keypair,
  buyer: Keypair,
  solAmount: number,
  minOutArr: BN[],
  quoteToken: Token,
  baseToken: Token,
  baseDecimal: number,
  poolInfo: any,
  raydium: Raydium | undefined,
  walletNum: number,
  shouldSell: boolean,
  addressLookupTable: string,
  refundSubwalletSol: boolean = true
) => {
  if (raydium == undefined) {
    return { volTx: null, isSell: false };
  }
  let versionedTransactions = [];
  let isSell = false;

  try {
    const { instructions, minOut } = await buyTokenInstructionRaydium(
      connection,
      buyer,
      solAmount,
      quoteToken,
      baseToken,
      poolInfo,
      raydium
    );
    minOutArr[walletNum] = minOut;
    versionedTransactions.push(...instructions);

    // console.log("Buy Token Amount:", minOutArr[walletNum].toNumber());

    if (shouldSell) {
      console.log("Selling at position:", walletNum);
      isSell = true;

      // Calculate total bought amount up to this point
      let totalBought = new BN(0);
      for (let i = 0; i <= walletNum; i++) {
        if (minOutArr[i]) {
          totalBought = totalBought.add(minOutArr[i]);
          minOutArr[i] = new BN(0);
        }
      }


      let tokenBalance = 0;
      if (walletNum == MAKER_BOT_MAX_PER_TX - 1) {
        tokenBalance = await getTokenBalance(
          connection,
          baseToken.mint.toString(),
          buyer.publicKey,
          baseDecimal,
          baseToken.programId == TOKEN_2022_PROGRAM_ID
        );
      }

      // Sell everything accumulated so far
      let tokenAmountToSell = new BN(tokenBalance * 10 ** baseDecimal).add(totalBought);

      if (tokenAmountToSell.isZero()) return { volTx: null, isSell: false };

      // console.log("tokenAmountToSell:", tokenAmountToSell.toNumber());
      const { instructions: sellInstructions } = await sellTokenInstructionRaydium(
        connection,
        buyer,
        tokenAmountToSell,
        quoteToken,
        baseToken,
        poolInfo,
        raydium
      );
      versionedTransactions.push(...sellInstructions);

      // refund rent account sol to buyer
      if (refundSubwalletSol) {
        versionedTransactions.push(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: buyer.publicKey,
            lamports: 890880,
          })
        );
      }
    }
  } catch (error: any) {
    console.log("ERROR: Make buy and sell transaction error.", error?.message);
    // in the case the error is "input token account not found" create token account
    if (error?.message?.includes("input token account not found")) {
      const res = await createTokenAccountTxRaydium(
        connection,
        payer,
        baseToken.mint,
        poolInfo,
        raydium,
        baseToken.programId == TOKEN_2022_PROGRAM_ID
      );
      if (res) {
        console.log("Token account created successfully.");
      }
    }
    return { volTx: null, isSell: false };
  }

  // add jito tip instruction to the last transaction
  if (walletNum == 0) {
    const instruction = await getTipInstruction(buyer.publicKey, JITO_BUNDLE_TIP / LAMPORTS_PER_SOL);

    if (!instruction) {
      return { volTx: null, isSell: false };
    }
    versionedTransactions.push(instruction);
  }

  const tx = await makeVersionedTransactionsWithMultiSign(
    connection,
    [buyer, payer],
    versionedTransactions,
    addressLookupTable,
    solAmount
  );

  // const simRes = await connection.simulateTransaction(tx);
  // if (simRes.value.err) {
  //   console.log("simRes : ", simRes);
  //   return {volTx: null, isSell: false};
  // }

  return { volTx: tx, isSell };
};


/**
 * Creates a buy and sell transaction for Raydium Ranker
 */
export const makeBuySellTransactionRaydiumRank = async (
  connection: Connection,
  payer: Keypair,
  buyer: Keypair,
  solAmount: BN,
  quoteToken: Token,
  baseToken: Token,
  baseDecimal: number,
  poolInfo: any,
  raydium: Raydium | undefined,
  walletNum: number,
  clean: boolean,
  organicMode: boolean,
  addressLookupTable: string,
  refundSubwalletSol: boolean = true,
) => {
  if (raydium == undefined) {
    console.log("Raydium SDK is not initialized.");
    return { volTx: null, isSell: false };
  }
  let versionedTransactions = [];
  let isSell = false;

  try {
    if (!organicMode) {
      const { instructions, minOut } = await buyTokenInstructionRaydium(
        connection,
        buyer,
        solAmount.toNumber(),
        quoteToken,
        baseToken,
        poolInfo,
        raydium
      );
      versionedTransactions.push(...instructions);
    }
    else {
      const randfactor = getRandomNumber(0, 3, 0);
      const { instructions, minOut } = await buyTokenInstructionRaydium(
        connection,
        buyer,
        solAmount.toNumber(),
        quoteToken,
        baseToken,
        poolInfo,
        raydium
      );
      versionedTransactions.push(...instructions);
      if (walletNum == randfactor) {
        isSell = true;
        let tokenAmountToSell = minOut;//tokenBalance * 10 ** baseDecimal
        const { instructions: sellInstrunctions } = await sellTokenInstructionRaydium(
          connection,
          buyer,
          tokenAmountToSell,
          quoteToken,
          baseToken,
          poolInfo,
          raydium
        );
        versionedTransactions.push(...sellInstrunctions);
      }
    }

    if (refundSubwalletSol) {
      versionedTransactions.push(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: buyer.publicKey,
          lamports: 890880,
        })
      );
    }
  } catch (error) {
    console.log("ERROR: Make buy and sell transaction error.", error);
    return { volTx: null, isSell: false };
  }

  // add jito tip instruction to the last transaction
  if (walletNum == 0) {
    const instruction = await getTipInstruction(buyer.publicKey, JITO_BUNDLE_TIP / LAMPORTS_PER_SOL);

    if (!instruction) {
      return { volTx: null, isSell: false };
    }
    versionedTransactions.push(instruction);
  }

  const tx = await makeVersionedTransactionsWithMultiSign(
    connection,
    [buyer, payer],
    versionedTransactions,
    addressLookupTable
  );

  // let simRes = await connection.simulateTransaction(tx);
  // if (simRes.value.err) {
  //   console.log("simRes : ", simRes.value.err);
  //   return {volTx: null, isSell: false};
  // }

  return { volTx: tx, isSell };
};

/**
 * Creates a buy and sell transaction for Raydium Holder
 */
export const makeBuyTransactionRaydiumHolder = async (
  connection: Connection,
  buyer: Keypair,
  mainWallet: Keypair,
  solAmount: BN,
  quoteToken: Token,
  baseToken: Token,
  poolInfo: any,
  walletNum: number,
  addressLookupTable: string,
) => {
  let raydium = await addRaydiumSDK(buyer.publicKey)
  if (raydium == undefined) {
    return { volTx: null, isSell: false };
  }
  let versionedTransactions = [];
  let isSell = false;

  try {
    const { instructions, minOut } = await buyTokenInstructionRaydium(
      connection,
      buyer,
      solAmount.toNumber(),
      quoteToken,
      baseToken,
      poolInfo,
      raydium
    );
    versionedTransactions.push(...instructions);
  } catch (error) {
    console.log("ERROR: Make buy and sell transaction error.", error);
    return { volTx: null, isSell: false };
  }

  // refund not used sol to buyer
  versionedTransactions.push(
    SystemProgram.transfer({
      fromPubkey: buyer.publicKey,
      toPubkey: mainWallet.publicKey,
      lamports: 3000000,
    })
  );

  // add jito tip instruction to the last transaction
  if (walletNum == 0) {
    const instruction = await getTipInstruction(buyer.publicKey, JITO_BUNDLE_TIP / LAMPORTS_PER_SOL);

    if (!instruction) {
      return { volTx: null, isSell: false };
    }
    versionedTransactions.push(instruction);
  }

  const tx = await makeVersionedTransactionsWithMultiSign(
    connection,
    [buyer],
    versionedTransactions,
    addressLookupTable
  );

  // let simRes = await connection.simulateTransaction(tx);
  // if (simRes.value.err) {
  //   console.log("simRes : ", simRes.value.err);
  //   return {volTx: null, isSell: false};
  // }

  return { volTx: tx, isSell };
};

// build sell only transaction
export const makeSellTransactionRaydium = async (
  connection: Connection,
  buyer: Keypair,
  quoteToken: Token,
  baseToken: Token,
  baseDecimal: number,
  poolInfo: any,
  raydium: Raydium | undefined,
  addressLookupTable: string
) => {
  if (raydium == undefined) {
    return { volTx: null, isSell: false };
  }
  let versionedTransactions = [];
  let isSell = false;
  try {
    const tokenBalance = await getTokenBalance(
      connection,
      baseToken.mint.toString(),
      buyer.publicKey,
      baseDecimal,
      baseToken.programId == TOKEN_2022_PROGRAM_ID
    );

    let tokenAmountToSell = new BN(tokenBalance * 10 ** baseDecimal);
    console.log("tokenAmountToSell:", tokenAmountToSell);
    const { instructions: sellInstrunctions } = await sellTokenInstructionRaydium(
      connection,
      buyer,
      tokenAmountToSell,
      quoteToken,
      baseToken,
      poolInfo,
      raydium
    );
    versionedTransactions.push(...sellInstrunctions);
  } catch (error) {
    console.log("ERROR: Make sell transaction error.", error);
    return { volTx: null, isSell: false };
  }

  const tx = await makeVersionedTransactionsWithMultiSign(
    connection,
    [buyer, buyer],
    versionedTransactions,
    addressLookupTable
  );
  return { volTx: tx, isSell };
};

export const sellTokenInstructionRaydium = async (
  connection: Connection,
  seller: Keypair,
  tokenAmount: any,
  quoteToken: Token,
  baseToken: Token,
  poolInfo: any,
  raydium: Raydium | undefined
) => {
  let poolType = "";

  if (raydium == undefined) {
    return { instructions: [], minOut: 0 };
  }

  if (isValidCpmm(poolInfo.programId)) {
    poolType = "cpmm";
  } else if (isValidAmm(poolInfo.programId)) {
    poolType = "amm";
  } else if (isValidClmm(poolInfo.programId)) {
    poolType = "clmm";
  } else if (isValidLaunchpad(poolInfo.programId)) {
    poolType = "launchlab";
  }

  // console.log('>>>>>>>>>>>>> poolType : ', poolType);

  if (!poolType || poolType.length == 0) {
    return { instructions: [], minOut: 0 };
  }

  const inputAmount = new BN(tokenAmount);

  if (poolType == "cpmm") {
    const rpcData = await raydium.cpmm.getRpcPoolInfo(poolInfo.id, true);

    const inputMint = baseToken.mint.toString();
    const baseIn = inputMint === poolInfo.mintA.address;

    // swap pool mintA for mintB
    const swapResult = CurveCalculator.swap(
      inputAmount,
      baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
      baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
      rpcData.configInfo ? rpcData.configInfo.tradeFeeRate : new BN(0)
    );

    // console.log("swapResult", swapResult);

    // console.log(await connection.simulateTransaction(tipTransaction))
    const { transaction } = await raydium.cpmm.swap<TxVersion.LEGACY>({
      payer: seller.publicKey,
      poolInfo: poolInfo as any,
      swapResult: swapResult,
      slippage: 0.5, // range: 1 ~ 0.0001, means 100% ~ 0.01%
      baseIn,
      txVersion: TxVersion.LEGACY,
      inputAmount: inputAmount,
      // optional: set up priority fee here
      // computeBudgetConfig: {
      //   microLamports: 100000,
      // },
    });

    return {
      instructions: transaction.instructions,
      minOut: swapResult.destinationAmountSwapped.toNumber(),
    };
  } else if (poolType == "amm") {
    const poolKeys = await raydium.liquidity.getAmmPoolKeys(poolInfo.id);
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

    const amountIn = tokenAmount;
    try {
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

      const { transaction } = await raydium.liquidity.swap({
        poolInfo: poolInfo as any,
        poolKeys,
        amountIn: new BN(amountIn),
        amountOut: out.minAmountOut, // out.amountOut means amount 'without' slippage
        fixedSide: "in",
        inputMint: mintIn.address,
        // associatedOnly: false,
        // config: {
        //   associatedOnly: false,
        // },
        txVersion: TxVersion.LEGACY,
        // computeBudgetConfig: {
        //   // units: 1000000,
        //   microLamports: 100,
        // }
      });

      return {
        instructions: transaction.instructions,
        minOut: out.minAmountOut.toNumber(),
      };
    } catch (error: any) {
      if (error.message.includes("No enough initialized tickArray")) {
        console.warn("Skipped transaction due to uninitialized liquidity range");
        // Optionally adjust your price or skip to next opportunity
      } else {
        throw error; // Unknown error, rethrow
      }
    }
  } else if (poolType == "clmm") {
    const clmmPoolInfo = await PoolUtils.fetchComputeClmmInfo({
      connection: raydium.connection,
      poolInfo: poolInfo as any,
    });
    const tickCache = await PoolUtils.fetchMultiplePoolTickArrays({
      connection: raydium.connection,
      poolKeys: [clmmPoolInfo],
    });

    const inputMint = baseToken.mint.toString();
    const baseIn = inputMint === poolInfo.mintA.address;
    const [mintIn, mintOut] = baseIn
      ? [poolInfo.mintA, poolInfo.mintB]
      : [poolInfo.mintB, poolInfo.mintA];

    try {
      const { minAmountOut, remainingAccounts } =
        PoolUtils.computeAmountOutFormat({
          poolInfo: clmmPoolInfo,
          tickArrayCache: tickCache[poolInfo.id],
          amountIn: inputAmount,
          tokenOut: mintOut,
          slippage: 0.1,
          epochInfo: await raydium.fetchEpochInfo(),
        });

      const { transaction } = await raydium.clmm.swap({
        poolInfo: poolInfo as any,
        // poolKeys: ,
        inputMint: poolInfo[baseIn ? "mintA" : "mintB"].address,
        amountIn: inputAmount,
        amountOutMin: minAmountOut.amount.raw,
        observationId: clmmPoolInfo.observationId,
        ownerInfo: {
          useSOLBalance: true, // if wish to use existed wsol token account, pass false
        },
        remainingAccounts,
        txVersion: TxVersion.LEGACY,
      });

      return {
        instructions: transaction.instructions,
        minOut: minAmountOut.amount.raw.toNumber(),
      };
    } catch (error: any) {
      if (error.message.includes("No enough initialized tickArray")) {
        console.warn("Skipped transaction due to uninitialized liquidity range");
        // Optionally adjust your price or skip to next opportunity
      } else {
        throw error; // Unknown error, rethrow
      }
    }
  } else if (poolType == "launchlab") {
    const { transaction, extInfo, execute } = await raydium.launchpad.sellToken({
      programId: new PublicKey(poolInfo.programId),
      mintA: poolInfo.mintA.address,
      slippage: new BN(1000), // 10%
      configInfo: poolInfo.configInfo,
      platformFeeRate: poolInfo.platformFeeRate,
      txVersion: TxVersion.LEGACY,
      sellAmount: inputAmount,
      // computeBudgetConfig: {
      //   units: 600000,
      //   microLamports: 600000,
      // },
    })

    return {
      instructions: transaction.instructions,
      minOut: extInfo.outAmount,
    };
  }

  return { instructions: [], minOut: 0 };
};

export const buyTokenInstructionRaydium = async (
  connection: Connection,
  buyer: Keypair,
  solAmount: number,
  quoteToken: Token,
  baseToken: Token,
  poolInfo: ApiV3PoolInfoItem | any,
  raydium: Raydium | undefined
) => {
  let poolType = "";

  if (raydium == undefined) {
    console.log("Raydium SDK is not initialized.");
    return { instructions: [], minOut: new BN(0) };
  }

  if (isValidCpmm(poolInfo.programId)) {
    poolType = "cpmm";
  } else if (isValidAmm(poolInfo.programId)) {
    poolType = "amm";
  } else if (isValidClmm(poolInfo.programId)) {
    poolType = "clmm";
  } else if (isValidLaunchpad(poolInfo.programId)) {
    poolType = "launchlab";
  }

  // console.log('>>>>>>>>>>>>> poolType : ', poolType);

  if (!poolType || poolType.length == 0) {
    return { instructions: [], minOut: new BN(0) };
  }

  const inputAmount = new BN(Math.floor(solAmount));

  // console.log("buyer", buyer.publicKey.toString());
  // console.log("baseToken", baseToken.mint.toString());
  // console.log("solAmount", inputAmount.toString());

  if (poolType == "cpmm") {
    const rpcData = await raydium.cpmm.getRpcPoolInfo(poolInfo.id, true);

    const inputMint = baseToken.mint.toString();
    const baseIn = inputMint === poolInfo.mintB.address;

    // swap pool mintA for mintB
    const swapResult = CurveCalculator.swap(
      inputAmount,
      baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
      baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
      rpcData.configInfo ? rpcData.configInfo.tradeFeeRate : new BN(0)
    );

    // console.log("swapResult", swapResult);

    // console.log(await connection.simulateTransaction(tipTransaction))
    const { transaction } = await raydium.cpmm.swap<TxVersion.LEGACY>({
      payer: buyer.publicKey,
      poolInfo: poolInfo as any,
      swapResult: swapResult,
      slippage: 0.3, // range: 1 ~ 0.0001, means 100% ~ 0.01%
      baseIn,
      txVersion: TxVersion.LEGACY,
      inputAmount: inputAmount,
      fixedOut: true,
      // optional: set up priority fee here
      // computeBudgetConfig: {
      //   microLamports: 100000,
      // },
    });

    return {
      instructions: transaction.instructions,
      minOut: swapResult.destinationAmountSwapped,
    };
  } else if (poolType == "amm") {
    const poolKeys = await raydium.liquidity.getAmmPoolKeys(poolInfo.id);
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

    const baseIn = inputMint === poolInfo.mintB.address;
    const [mintIn, mintOut] = baseIn
      ? [poolInfo.mintA, poolInfo.mintB]
      : [poolInfo.mintB, poolInfo.mintA];

    try {
      const out = raydium.liquidity.computeAmountOut({
        poolInfo: {
          ...poolInfo,
          baseReserve,
          quoteReserve,
          status,
          version: 4,
        } as any,
        amountIn: inputAmount,
        mintIn: mintIn.address,
        mintOut: mintOut.address,
        slippage: 0.1, // range: 1 ~ 0.0001, means 100% ~ 0.01%
      });

      const { transaction } = await raydium.liquidity.swap({
        poolInfo: poolInfo as any,
        poolKeys,
        amountIn: inputAmount,
        amountOut: out.minAmountOut, // out.amountOut means amount 'without' slippage
        fixedSide: "out",
        inputMint: mintIn.address,
        // associatedOnly: false,
        // config: {
        //   associatedOnly: false,
        // },
        txVersion: TxVersion.LEGACY,
        // computeBudgetConfig: {
        //   // units: 1000000,
        //   microLamports: 100,
        // }
      });

      return {
        instructions: transaction.instructions,
        minOut: out.minAmountOut,
      };
    } catch (error: any) {
      if (error.message.includes("No enough initialized tickArray")) {
        console.warn("Skipped transaction due to uninitialized liquidity range");
        // Optionally adjust your price or skip to next opportunity
      } else {
        throw error; // Unknown error, rethrow
      }
    }
  } else if (poolType == "clmm") {
    const clmmPoolInfo = await PoolUtils.fetchComputeClmmInfo({
      connection: raydium.connection,
      poolInfo: poolInfo as any,
    });
    const tickCache = await PoolUtils.fetchMultiplePoolTickArrays({
      connection: raydium.connection,
      poolKeys: [clmmPoolInfo],
    });

    const inputMint = baseToken.mint.toString();
    const baseIn = inputMint === poolInfo.mintB.address;
    const [mintIn, mintOut] = baseIn
      ? [poolInfo.mintA, poolInfo.mintB]
      : [poolInfo.mintB, poolInfo.mintA];

    try {
      const { minAmountOut, remainingAccounts } =
        PoolUtils.computeAmountOutFormat({
          poolInfo: clmmPoolInfo,
          tickArrayCache: tickCache[poolInfo.id],
          amountIn: inputAmount,
          tokenOut: mintOut,
          slippage: 0.1,
          epochInfo: await raydium.fetchEpochInfo(),
        });

      // const { transaction } = await raydium.clmm.swap({
      //   poolInfo: poolInfo as any,
      //   // poolKeys: ,
      //   inputMint: poolInfo[baseIn ? "mintA" : "mintB"].address,
      //   amountIn: inputAmount,
      //   amountOutMin: minAmountOut.amount.raw,
      //   observationId: clmmPoolInfo.observationId,
      //   ownerInfo: {
      //     useSOLBalance: true, // if wish to use existed wsol token account, pass false
      //   },
      //   remainingAccounts,
      //   txVersion: TxVersion.LEGACY,
      // });

      const { transaction } = await raydium.clmm.swapBaseOut({
        poolInfo: poolInfo as any,
        // poolKeys: ,
        outputMint: poolInfo[baseIn ? "mintB" : "mintA"].address,
        amountInMax: inputAmount,
        amountOut: minAmountOut.amount.raw,
        observationId: clmmPoolInfo.observationId,
        ownerInfo: {
          useSOLBalance: true, // if wish to use existed wsol token account, pass false
        },
        remainingAccounts,
        txVersion: TxVersion.LEGACY,
      });

      return {
        instructions: transaction.instructions,
        minOut: minAmountOut.amount.raw,
      };
    } catch (error: any) {
      if (error.message.includes("No enough initialized tickArray")) {
        console.warn("Skipped transaction due to uninitialized liquidity range");
        // Optionally adjust your price or skip to next opportunity
      } else {
        throw error; // Unknown error, rethrow
      }
    }
  } else if (poolType == "launchlab") {
    const { transaction, extInfo, execute } = await raydium.launchpad.buyToken({
      programId: new PublicKey(poolInfo.programId),
      mintA: poolInfo.mintA.address,
      slippage: new BN(1000), // 10%
      configInfo: poolInfo.configInfo,
      platformFeeRate: poolInfo.platformFeeRate,
      txVersion: TxVersion.LEGACY,
      buyAmount: inputAmount,
      // computeBudgetConfig: {
      //   units: 600000,
      //   microLamports: 600000,
      // },
    })

    return {
      instructions: transaction.instructions,
      minOut: extInfo.outAmount,
    };
  }

  return { instructions: [], minOut: new BN(0) };
};


export const sellToken = async (
  connection: Connection,
  seller: Keypair,
  tokenAmount: any,
  quoteToken: Token,
  baseToken: Token,
  poolInfo: any,
  raydium: Raydium | undefined
) => {
  const { instructions, minOut } = await sellTokenInstructionRaydium(
    connection,
    seller,
    tokenAmount,
    quoteToken,
    baseToken,
    poolInfo,
    raydium
  );

  if (instructions.length == 0) {
    return null;
  }

  const versionTx = await makeVersionedTransactions(
    connection,
    seller,
    instructions
  );
  versionTx.sign([seller]);

  return { transaction: versionTx, minOut: minOut };
};

export const buyToken = async (
  connection: Connection,
  buyer: Keypair,
  solAmount: number,
  quoteToken: Token,
  baseToken: Token,
  poolInfo: ApiV3PoolInfoItem,
  raydium: Raydium | undefined
) => {
  const { instructions, minOut } = await buyTokenInstructionRaydium(
    connection,
    buyer,
    solAmount,
    quoteToken,
    baseToken,
    poolInfo,
    raydium
  );

  if (instructions.length == 0) {
    return { transaction: null, minOut: 0 };
  }

  const versionTx = await makeVersionedTransactions(
    connection,
    buyer,
    instructions
  );
  versionTx.sign([buyer]);

  const simRes = await connection.simulateTransaction(versionTx);

  return { transaction: versionTx, minOut: minOut };
};
