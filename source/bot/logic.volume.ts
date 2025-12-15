require("require-esm-as-empty-object");

import { Bot, session, InputFile } from "grammy";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as Web3 from '@solana/web3.js';
import { getMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SOL, Token } from "@raydium-io/raydium-sdk";
import bs58 from "bs58";
import BN from "bn.js";
import {
  getPoolInfo,
  createAndSendBundle,
  validateAddress,
  withdrawSOL,
  updateRecentBlockHash,
  createAndSendBundleEx,
  getRandomNumber,
  formatTime,
  formatNumberWithUnit,
  getSolanaPriceBinance,
  handleMessage,
  selectTradingPattern,
  makeVersionedTransactionsWithMultiSign,
  toast,
  getTipInstruction,
  createAndSendBundleExV2,
  getReferralTaxInstruction,
  SOL_PRICE
} from "../utils/common";

import AdminModel from "../database/models/admin.model";
import TokenModel from "../database/models/token.model";
import VolumeBotModel from "../database/models/volumebot.model";
import { setIntervalAsync } from "set-interval-async/dynamic";
import { initSdk } from "../utils/sdkv2";
import * as database from "../database/db";
import { createTokenAccountTxPumpswap, makeBuySellTransactionPumpswapVolume } from "../dexs/pumpswap";

import {
  volumeBotUpdateStatus,
} from "./action";

import {
  BOT_STATUS,
  connection,
  connection2,
  MAX_WALLET_COUNT,
  quoteToken,
  raydiumSDKList,
  MAKER_BOT_MAX_PER_TX,
  volumeBots,
  ADMIN_USERS,
  MAX_BUNDLE_FAILED_COUNT,
  MIN_REMAIN_SOL,
  ONE_K_VOL_PRICE,
  BONUS_THRESHOLD,
  BONUS_WALLET,
} from "./const";
import { SystemProgram } from "@solana/web3.js";
import { sleep } from "../utils/common";
import * as path from 'path';
import { randomInt } from "crypto";
import { Connection } from "@solana/web3.js";
import { TransactionInstruction } from "@solana/web3.js";
import { createTokenAccountTxRaydium, makeBuySellTransactionRaydiumVolume, makeSellTransactionRaydium } from "../dexs/raydium";
import { addRaydiumSDK, alertToAdmins, bot, notifyToChannel, sessions } from ".";
import { createTokenAccountTxPumpFun, makeBuySellTransactionPumpFunVolume } from "../dexs/pumpfun";
import { createTokenAccountTxMeteora, initMeteoraBuy, makeBuySellTransactionMeteoraVolume } from "../dexs/meteora";
import AmmImpl from "@meteora-ag/dynamic-amm-sdk";
import DLMM from "@meteora-ag/dlmm-sdk-public";
import { sub } from "@raydium-io/raydium-sdk-v2";
import zombieModel from "../database/models/zombie.model";
import { version } from "os";

const MAIN_WALLET_KEY = process.env.MAIN_WALLET_KEY
  ? process.env.MAIN_WALLET_KEY
  : "";
const MAIN_WALLET = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_KEY));

export async function volumeMaker() {
  try {
    // console.log(`✅ SOL price: ${SOL_PRICE}`);
    //find all bots that has start true value in startStopFlag
    const startedBots = await VolumeBotModel.find({ $and: [{ enable: true }, { 'boostType.volumeBoost': true }] })
      .populate("mainWallet enable token")
      .lean();

    if (!startedBots || startedBots.length == 0) {
      return;
    }

    console.log("volumeBots.length", startedBots.length);
    for (let index = 0; index < startedBots.length; index++) {
      const botOnSolana: any = startedBots[index];

      if (botOnSolana == null) {
        continue;
      }

      if (volumeBots.get(botOnSolana._id)) continue;

      volumeBots.set(botOnSolana._id, true);

      if (botOnSolana?.dexId == "raydium") {
        // raydiumVolumeMakerFunc(botOnSolana, true);
        raydiumVolumeMakerFunc(botOnSolana);
      } else if (botOnSolana?.dexId == "pumpswap") {
        // pumpSwapVolumeMakerFunc(botOnSolana, true);
        pumpSwapVolumeMakerFunc(botOnSolana);
      } else if (botOnSolana?.dexId == "pumpfun") {
        // pumpfunVolumeMakerFunc(botOnSolana, true);
        pumpfunVolumeMakerFunc(botOnSolana);
      } else if (botOnSolana?.dexId == "meteora") {
        // meteoraVolumeMakerFunc(botOnSolana, true);
        meteoraVolumeMakerFunc(botOnSolana);
      }

      volumeBots.delete(botOnSolana._id);

      await sleep(1500);
    }
  } catch (err) {
    console.error(err);
  }
}

async function raydiumVolumeMakerFunc(curbotOnSolana: any, sideBuy = false) {
  // Early return checks and initialization
  if (!sideBuy) {
    if (volumeBots.get(curbotOnSolana._id.toString())) return;
    volumeBots.set(curbotOnSolana._id.toString(), true);
  } else {
    if (volumeBots.get(curbotOnSolana._id.toString() + "_side")) return;
    volumeBots.set(curbotOnSolana._id.toString() + "_side", true);

    // postpone 15-30 sec for side buy
    let delayFor = randomInt(15, 30);
    setTimeout(() => { }, delayFor * 1000);
  }

  console.log(">>>>>>> @ current Token : ", curbotOnSolana?.token?.address);

  let running = true;
  let initialBundleFailedCount = 0;

  // Initialize token and pool
  const { baseToken, poolInfo, isCPMM } = await initializeTokenAndPool(curbotOnSolana);
  if (!poolInfo) {
    console.log("[Volume] Can't get pool info of tokens", curbotOnSolana.token.address);
    volumeBots.delete(curbotOnSolana._id.toString());
    return;
  }

  // // Update target volume based on deposit and bonus
  // await updateTargetVolume(curbotOnSolana, poolInfo);

  while (running) {
    // Get latest bot info from database
    const botOnSolana = await VolumeBotModel.findOne({
      userId: curbotOnSolana.userId,
    })
      .populate("mainWallet token targetVolume enable usedWallet volumeMade delayTime maxBuy")
      .lean();

    if (!botOnSolana || botOnSolana.enable == false || initialBundleFailedCount > MAX_BUNDLE_FAILED_COUNT) {
      break;
    }

    // Extract bot parameters
    let { workedSeconds = 0, delayTime = 0, volumeMade = 0, txDone = 0,
      targetVolume = 0, usedWallet = 0, startSolAmount = 0 } = botOnSolana;
    let newSpentSeconds = 0;

    try {
      const startTime = Date.now();

      // Get wallets and check balances
      const { subWallets, mainWallet, userBalance, mainBalance } = await prepareWallets(botOnSolana, usedWallet);

      const profitAmount = (Number(mainBalance - startSolAmount) / 10 ** 9) + Number(MIN_REMAIN_SOL);

      // Setup address lookup table if not exist
      if (botOnSolana.dexId == "raydium" && (botOnSolana.addressLookupTable == "" || botOnSolana.addressLookupTable == null || botOnSolana.addressLookupTable == undefined)) {
        const lookupTableAddress = await createTokenAccountTxRaydium(
          connection,
          mainWallet,
          baseToken.mint,
          poolInfo,
          raydiumSDKList.get(mainWallet.publicKey.toString()),
          curbotOnSolana.token?.is2022
        );

        if (lookupTableAddress) {
          await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
            addressLookupTable: lookupTableAddress,
          });
          botOnSolana.addressLookupTable = lookupTableAddress.toString();
        } else {
          break;
        }
      }

      if (botOnSolana.dexId == "raydium" && (botOnSolana.addressLookupTable == "" || botOnSolana.addressLookupTable == null || botOnSolana.addressLookupTable == undefined)) {
        console.log("[Volume] Address lookup table not found. Break!");
        break;
      }

      // Update pool info and calculate transaction amounts
      const { maxBuyAmount, newMadeVolume, transactions } = await prepareTransactions(
        botOnSolana,
        curbotOnSolana,
        isCPMM,
        userBalance,
        userBalance,
        subWallets,
        baseToken,
        quoteToken,
        poolInfo,
        sideBuy
      );

      if (!transactions.versionedTx.length || transactions.versionedTx.length < MAKER_BOT_MAX_PER_TX) {
        console.log("Bundle is not enough to make transaction");
        continue;
      }

      // Sign transactions
      const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      for (let i = 0; i < transactions.versionedTx.length; i++) {
        if (transactions.versionedTx[i]) {
          transactions.versionedTx[i].message.recentBlockhash = recentBlockhash;
          transactions.versionedTx[i].sign(transactions.signers[i]);
        }
      }

      console.log("Volume making...");

      // Execute transactions and update stats
      const success = await executeTransactions(
        connection,
        mainWallet,
        transactions.versionedTx,
        delayTime,
        botOnSolana,
        newMadeVolume,
        transactions.sellCount
      );

      if (!success && txDone === 0) {
        initialBundleFailedCount++;
        continue;
      }

      // Update used wallet count and time tracking
      usedWallet += MAKER_BOT_MAX_PER_TX;
      if (volumeMade >= targetVolume) {
        await new Promise(resolve => setTimeout(resolve, 60000));
      } else {
        await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
          usedWallet: usedWallet % MAX_WALLET_COUNT,
        });
      }

      const endTime = Date.now();
      newSpentSeconds = (endTime - startTime) / 1000;
      workedSeconds = Number(workedSeconds) + Number(newSpentSeconds);

      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        workedSeconds: workedSeconds,
      });

      // Stop when remaining balance is below threshold
      if (!sideBuy) {
        if (volumeMade >= targetVolume) {
          await handleCompletedBot(botOnSolana, curbotOnSolana, profitAmount, baseToken, poolInfo, quoteToken, isCPMM);
          await volumeBotUpdateStatus(botOnSolana._id, BOT_STATUS.ARCHIVED_TARGET_VOLUME);
          break;
        }

        const currentLamports = userBalance;
        if (currentLamports <= MIN_REMAIN_SOL * LAMPORTS_PER_SOL) {
          console.log("Remaining balance below threshold, stopping volume bot.");
          await handleCompletedBot(botOnSolana, curbotOnSolana, profitAmount, baseToken, poolInfo, quoteToken, isCPMM);
          await volumeBotUpdateStatus(botOnSolana._id, BOT_STATUS.STOPPED_DUE_TO_MAIN_WALLET_BALANCE);
          break;
        }
      }

      // // Sleep if needed (handled inside executeTransactions for delayTime > 30)
      // if (delayTime <= 30 && success) {
        console.log("sleeping seconds: ", delayTime);
        await sleep(delayTime * 1000);
      // }
    } catch (err) {
      console.error(err);
    }
  }

  // Cleanup
  if (!sideBuy)
    volumeBots.delete(curbotOnSolana._id.toString());
  else
    volumeBots.delete(curbotOnSolana._id.toString() + "_side");
}

async function pumpSwapVolumeMakerFunc(curbotOnSolana: any, sideBuy = false) {
  // Early return checks and initialization
  if (!sideBuy) {
    if (volumeBots.get(curbotOnSolana._id.toString())) return;
    volumeBots.set(curbotOnSolana._id.toString(), true);
  } else {
    if (volumeBots.get(curbotOnSolana._id.toString() + "_side")) return;
    volumeBots.set(curbotOnSolana._id.toString() + "_side", true);

    // postpone 15-30 sec for side buy
    let delayFor = randomInt(15, 30);
    setTimeout(() => { }, delayFor * 1000);
  }

  console.log(">>>>>>>[pumpswap] @ current Token : ", curbotOnSolana?.token?.address);

  let running = true;
  let initialBundleFailedCount = 0;

  // Initialize token and pool
  const { baseToken, poolInfo, isCPMM } = await initializeTokenAndPool(curbotOnSolana);
  if (!poolInfo) {
    console.log("[Volume] Can't get pool info of pumpswap token", curbotOnSolana.token.address);
    volumeBots.delete(curbotOnSolana._id.toString());
    return;
  }

  // // Update target volume based on deposit and bonus
  // await updateTargetVolume(curbotOnSolana, poolInfo);

  while (running) {
    // Get latest bot info from database
    const botOnSolana = await VolumeBotModel.findOne({
      userId: curbotOnSolana.userId,
    })
      .populate("mainWallet token targetVolume enable usedWallet volumeMade delayTime maxBuy")
      .lean();

    if (!botOnSolana || botOnSolana.enable == false || initialBundleFailedCount > MAX_BUNDLE_FAILED_COUNT) {
      break;
    }

    // Extract bot parameters
    let { workedSeconds = 0, delayTime = 0, volumeMade = 0, txDone = 0,
      targetVolume = 0, usedWallet = 0, startSolAmount = 0 } = botOnSolana;
    let newSpentSeconds = 0;

    try {
      const startTime = Date.now();

      // Get wallets and check balances
      const { subWallets, mainWallet, userBalance, mainBalance } = await prepareWallets(botOnSolana, usedWallet);

      const profitAmount = (Number(mainBalance - startSolAmount) / 10 ** 9) + Number(MIN_REMAIN_SOL);

      // Create Token Account for PumpFun
      const lookupTableAddress = await createTokenAccountTxPumpswap(
        connection,
        mainWallet,
        baseToken.mint,
      );

      if (lookupTableAddress !== "") {
        botOnSolana.addressLookupTable = lookupTableAddress;
        await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, { addressLookupTable: lookupTableAddress });
      }

      // Update pool info and calculate transaction amounts
      const { maxBuyAmount, newMadeVolume, transactions } = await prepareTransactions(
        botOnSolana,
        curbotOnSolana,
        isCPMM,
        userBalance,
        userBalance,
        subWallets,
        baseToken,
        quoteToken,
        poolInfo,
        sideBuy
      );

      if (!transactions.versionedTx.length || transactions.versionedTx.length < MAKER_BOT_MAX_PER_TX) {
        console.log("Bundle is not enough to make transaction");
        continue;
      }

      // Sign transactions
      for (let i = 0; i < transactions.versionedTx.length; i++) {
        if (transactions.versionedTx[i]) {
          transactions.versionedTx[i].sign(transactions.signers[i]);
          console.log("🔑  Signed transaction ", i, " : ", transactions.versionedTx[i].serialize().length);
        }
      }

      console.log("Volume making...");

      // Execute transactions and update stats
      const success = await executeTransactions(
        connection,
        mainWallet,
        transactions.versionedTx,
        delayTime,
        botOnSolana,
        newMadeVolume,
        transactions.sellCount
      );

      if (!success && txDone === 0) {
        initialBundleFailedCount++;
        continue;
      }

      // Update used wallet count and time tracking
      usedWallet += MAKER_BOT_MAX_PER_TX;
      if (volumeMade >= targetVolume) {
        await new Promise(resolve => setTimeout(resolve, 60000));
      } else {
        await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
          usedWallet: usedWallet % MAX_WALLET_COUNT,
        });
      }

      const endTime = Date.now();
      newSpentSeconds = (endTime - startTime) / 1000;
      workedSeconds = Number(workedSeconds) + Number(newSpentSeconds);

      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        workedSeconds: workedSeconds,
      });

      // Stop when targe volume reached or remaining balance is below threshold
      if (!sideBuy) {
        if (volumeMade >= targetVolume) {
          await handleCompletedBot(botOnSolana, curbotOnSolana, profitAmount, baseToken, poolInfo, quoteToken, isCPMM);
          await volumeBotUpdateStatus(botOnSolana._id, BOT_STATUS.ARCHIVED_TARGET_VOLUME);
          break;
        }

        const currentLamports = userBalance;
        if (currentLamports <= MIN_REMAIN_SOL * LAMPORTS_PER_SOL) {
          console.log("Remaining balance below threshold, stopping volume bot.");
          await handleCompletedBot(botOnSolana, curbotOnSolana, profitAmount, baseToken, poolInfo, quoteToken, isCPMM);
          await volumeBotUpdateStatus(botOnSolana._id, BOT_STATUS.STOPPED_DUE_TO_MAIN_WALLET_BALANCE);
          break;
        }
      }

      // Sleep if needed (handled inside executeTransactions for delayTime > 30)
      // if (delayTime <= 30 && success) {
      //   console.log("sleeping seconds: ", delayTime);
      //   await sleep(delayTime * 1000);
      // }
      // if (success) {
        console.log("sleeping seconds: ", delayTime);
        await sleep(delayTime * 1000);
      // }
    } catch (err) {
      console.error(err);
    }
  }

  // Cleanup
  if (!sideBuy)
    volumeBots.delete(curbotOnSolana._id.toString());
  else
    volumeBots.delete(curbotOnSolana._id.toString() + "_side");
}

async function pumpfunVolumeMakerFunc(curbotOnSolana: any, sideBuy = false) {
  // Early return checks and initialization
  if (!sideBuy) {
    if (volumeBots.get(curbotOnSolana._id.toString())) return;
    volumeBots.set(curbotOnSolana._id.toString(), true);
  } else {
    if (volumeBots.get(curbotOnSolana._id.toString() + "_side")) return;
    volumeBots.set(curbotOnSolana._id.toString() + "_side", true);

    // postpone 15-30 sec for side buy
    let delayFor = randomInt(15, 30);
    setTimeout(() => { }, delayFor * 1000);
  }

  let running = true;
  let initialBundleFailedCount = 0;

  // Initialize token and pool
  const { baseToken, poolInfo, isCPMM } = await initializeTokenAndPool(curbotOnSolana);
  if (!poolInfo) {
    console.log("[Volume] Can't get pool info of pumpfun token", curbotOnSolana.token.address);
    volumeBots.delete(curbotOnSolana._id.toString());
    return;
  }

  // // Update target volume based on deposit and bonus
  // await updateTargetVolume(curbotOnSolana, poolInfo);

  while (running) {
    // Get latest bot info from database
    const botOnSolana = await VolumeBotModel.findOne({
      userId: curbotOnSolana.userId,
    })
      .populate("mainWallet token targetVolume enable usedWallet volumeMade delayTime maxBuy")
      .lean();

    if (!botOnSolana || botOnSolana.enable == false || initialBundleFailedCount > MAX_BUNDLE_FAILED_COUNT) {
      break;
    }

    // Extract bot parameters
    let { workedSeconds = 0, delayTime = 0, volumeMade = 0, txDone = 0,
      targetVolume = 0, usedWallet = 0, startSolAmount = 0 } = botOnSolana;
    let newSpentSeconds = 0;

    try {
      const startTime = Date.now();

      // Get wallets and check balances
      const { subWallets, mainWallet, userBalance, mainBalance } = await prepareWallets(botOnSolana, usedWallet);

      const profitAmount = (Number(mainBalance - startSolAmount) / 10 ** 9) + Number(MIN_REMAIN_SOL);

      // Create Token Account for PumpFun
      const lookupTableAddress = await createTokenAccountTxPumpFun(
        connection,
        mainWallet,
        baseToken.mint,
        baseToken.programId.equals(TOKEN_2022_PROGRAM_ID)
      );

      // Update pool info and calculate transaction amounts
      const { maxBuyAmount, newMadeVolume, transactions } = await prepareTransactions(
        botOnSolana,
        curbotOnSolana,
        isCPMM,
        userBalance,
        userBalance,
        subWallets,
        baseToken,
        quoteToken,
        poolInfo,
        sideBuy
      );

      if (!transactions.versionedTx.length || transactions.versionedTx.length < MAKER_BOT_MAX_PER_TX) {
        console.log("Bundle is not enough to make transaction");
        continue;
      }

      // Sign transactions
      for (let i = 0; i < transactions.versionedTx.length; i++) {
        if (transactions.versionedTx[i])
          transactions.versionedTx[i].sign(transactions.signers[i]);
      }

      console.log("🥇 PumpFun Volume making...");

      // Execute transactions and update stats
      const success = await executeTransactions(
        connection,
        mainWallet,
        transactions.versionedTx,
        delayTime,
        botOnSolana,
        newMadeVolume,
        transactions.sellCount
      );

      if (!success && txDone === 0) {
        initialBundleFailedCount++;
        continue;
      }

      // Update used wallet count and time tracking
      usedWallet += MAKER_BOT_MAX_PER_TX;
      if (volumeMade >= targetVolume) {
        await new Promise(resolve => setTimeout(resolve, 60000));
      } else {
        await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
          usedWallet: usedWallet % MAX_WALLET_COUNT,
        });
      }

      const endTime = Date.now();
      newSpentSeconds = (endTime - startTime) / 1000;
      workedSeconds = Number(workedSeconds) + Number(newSpentSeconds);

      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        workedSeconds: workedSeconds,
      });

      // Stop when target volume reached or remaining balance is below threshold
      if (!sideBuy) {
        if (volumeMade >= targetVolume) {
          await handleCompletedBot(botOnSolana, curbotOnSolana, profitAmount, baseToken, poolInfo, quoteToken, isCPMM);
          await volumeBotUpdateStatus(botOnSolana._id, BOT_STATUS.ARCHIVED_TARGET_VOLUME);
          break;
        }

        const currentLamports = userBalance;
        if (currentLamports <= MIN_REMAIN_SOL * LAMPORTS_PER_SOL) {
          console.log("Remaining balance below threshold, stopping volume bot.");
          await handleCompletedBot(botOnSolana, curbotOnSolana, profitAmount, baseToken, poolInfo, quoteToken, isCPMM);
          await volumeBotUpdateStatus(botOnSolana._id, BOT_STATUS.STOPPED_DUE_TO_MAIN_WALLET_BALANCE);
          break;
        }
      }

      // // Sleep if needed (handled inside executeTransactions for delayTime > 30)
      // if (delayTime <= 30 && success) {
        console.log("sleeping seconds: ", delayTime);
        await sleep(delayTime * 1000);
      // }
    } catch (err) {
      console.error(err);
    }
  }

  // Cleanup
  if (!sideBuy)
    volumeBots.delete(curbotOnSolana._id.toString());
  else
    volumeBots.delete(curbotOnSolana._id.toString() + "_side");
}

async function meteoraVolumeMakerFunc(curbotOnSolana: any, sideBuy = false) {
  // Early return checks and initialization
  if (!sideBuy) {
    if (volumeBots.get(curbotOnSolana._id.toString())) return;
    volumeBots.set(curbotOnSolana._id.toString(), true);
  } else {
    if (volumeBots.get(curbotOnSolana._id.toString() + "_side")) return;
    volumeBots.set(curbotOnSolana._id.toString() + "_side", true);

    // postpone 15-30 sec for side buy
    let delayFor = randomInt(15, 30);
    setTimeout(() => { }, delayFor * 1000);
  }

  console.log(">>>>>>>[meteora] @ current Token : ", curbotOnSolana?.token?.address);

  let running = true;
  let initialBundleFailedCount = 0;

  // Initialize token and pool
  const { baseToken, poolInfo, isCPMM } = await initializeTokenAndPool(curbotOnSolana);
  if (!poolInfo) {
    console.log("[Volume] Can't get pool info of meteora token", curbotOnSolana.token.address);
    volumeBots.delete(curbotOnSolana._id.toString());
    return;
  }

  if (poolInfo) {
    await initMeteoraBuy(connection, poolInfo, curbotOnSolana.poolType, Keypair.fromSecretKey(bs58.decode(curbotOnSolana.mainWallet.privateKey)));
  }

  // // Update target volume based on deposit and bonus
  // await updateTargetVolume(curbotOnSolana, poolInfo);

  while (running) {
    // Get latest bot info from database
    const botOnSolana = await VolumeBotModel.findOne({
      userId: curbotOnSolana.userId,
    })
      .populate("mainWallet token")
      .lean();

    if (!botOnSolana || botOnSolana.enable == false || initialBundleFailedCount > MAX_BUNDLE_FAILED_COUNT) {
      break;
    }

    // Extract bot parameters
    let { workedSeconds = 0, delayTime = 0, volumeMade = 0, txDone = 0,
      targetVolume = 0, usedWallet = 0, startSolAmount = 0 } = botOnSolana;
    let newSpentSeconds = 0;

    try {
      const startTime = Date.now();

      // Get wallets and check balances
      const { subWallets, mainWallet, userBalance, mainBalance } = await prepareWallets(botOnSolana, usedWallet);

      const profitAmount = (Number(mainBalance - startSolAmount) / 10 ** 9) + Number(MIN_REMAIN_SOL);

      // // Create Token Account for Meteora
      // if ((botOnSolana.addressLookupTable == "" || botOnSolana.addressLookupTable == null || botOnSolana.addressLookupTable == undefined)) {
      //   const lookupTableAddress = await createTokenAccountTxMeteora(
      //     connection,
      //     mainWallet,
      //     baseToken.mint,
      //   );

      //   await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
      //     addressLookupTable: lookupTableAddress,
      //   });
      //   botOnSolana.addressLookupTable = lookupTableAddress.toString();
      // }

      // Update pool info and calculate transaction amounts
      const { maxBuyAmount, newMadeVolume, transactions } = await prepareTransactions(
        botOnSolana,
        curbotOnSolana,
        isCPMM,
        userBalance,
        userBalance,
        subWallets,
        baseToken,
        quoteToken,
        poolInfo,
        sideBuy
      );

      if (!transactions.versionedTx.length || transactions.versionedTx.length < MAKER_BOT_MAX_PER_TX) {
        console.log("Bundle is not enough to make transaction");
        continue;
      }

      // Sign transactions
      for (let i = 0; i < transactions.versionedTx.length; i++) {
        if (transactions.versionedTx[i])
          transactions.versionedTx[i].sign(transactions.signers[i]);
      }

      console.log("Volume making...");

      await initMeteoraBuy(connection, poolInfo, curbotOnSolana.poolType, mainWallet);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Execute transactions and update stats
      const success = await executeTransactions(
        connection,
        mainWallet,
        transactions.versionedTx,
        delayTime,
        botOnSolana,
        newMadeVolume,
        transactions.sellCount
      );

      if (!success && txDone === 0) {
        initialBundleFailedCount++;
        continue;
      }

      // Update used wallet count and time tracking
      usedWallet += MAKER_BOT_MAX_PER_TX;
      if (volumeMade >= targetVolume) {
        await new Promise(resolve => setTimeout(resolve, 60000));
      } else {
        await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
          usedWallet: usedWallet % MAX_WALLET_COUNT,
        });
      }

      const endTime = Date.now();
      newSpentSeconds = (endTime - startTime) / 1000;
      workedSeconds = Number(workedSeconds) + Number(newSpentSeconds);

      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        workedSeconds: workedSeconds,
      });

      // Stop when targetVolume reached or remaining balance is below threshold
      if (!sideBuy) {
        if (volumeMade >= targetVolume) {
          await handleCompletedBot(botOnSolana, curbotOnSolana, profitAmount, baseToken, poolInfo, quoteToken, isCPMM);
          await volumeBotUpdateStatus(botOnSolana._id, BOT_STATUS.ARCHIVED_TARGET_VOLUME);
          break;
        }

        const currentLamports = userBalance;
        if (currentLamports <= MIN_REMAIN_SOL * LAMPORTS_PER_SOL) {
          console.log("Remaining balance below threshold, stopping volume bot.");
          await handleCompletedBot(botOnSolana, curbotOnSolana, profitAmount, baseToken, poolInfo, quoteToken, isCPMM);
          await volumeBotUpdateStatus(botOnSolana._id, BOT_STATUS.STOPPED_DUE_TO_MAIN_WALLET_BALANCE);
          break;
        }
      }

      // // Sleep if needed (handled inside executeTransactions for delayTime > 30)
      // if (delayTime <= 30 && success) {
        console.log("sleeping seconds: ", delayTime);
        await sleep(delayTime * 1000);
      // }
    } catch (err) {
      console.error(err);
    }
  }

  // Cleanup
  if (!sideBuy)
    volumeBots.delete(curbotOnSolana._id.toString());
  else
    volumeBots.delete(curbotOnSolana._id.toString() + "_side");
}

// Function 2: Initialize token and pool information
async function initializeTokenAndPool(curbotOnSolana: any) {
  const token = curbotOnSolana.token.address;
  const mainWallet = Keypair.fromSecretKey(bs58.decode(curbotOnSolana.mainWallet.privateKey));
  console.log("User Wallet Address : ", mainWallet.publicKey.toBase58());

  const baseToken = new Token(
    curbotOnSolana.token?.is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    token,
    curbotOnSolana.token.decimals
  );

  if (curbotOnSolana && curbotOnSolana?.dexId == "raydium") {
    await addRaydiumSDK(mainWallet.publicKey);

    let poolInfo = await getPoolInfo(
      connection2,
      quoteToken,
      baseToken,
      raydiumSDKList.get(mainWallet.publicKey.toString()),
      curbotOnSolana.poolType.toLowerCase(),
    );

    let isCPMM = poolInfo?.config ? true : false;
    console.log("isCPMM or CLMM: ", isCPMM, "feeRate:", poolInfo?.feeRate);

    if (!poolInfo?.lpPrice || !poolInfo?.lpAmount) {
      console.log("Can't get lpAmount from pool of token: ", curbotOnSolana.token.address);
    }

    return { baseToken, poolInfo, isCPMM };
  } else if (curbotOnSolana && curbotOnSolana?.dexId == "pumpswap") {
    let poolInfo = {
      pairAddresss: curbotOnSolana.pairAddress,
      poolType: curbotOnSolana.poolType,
      dexId: curbotOnSolana.dexId,
      feeRate: 0.0025,
    }

    let isCPMM = false;

    return { baseToken, poolInfo, isCPMM };
  } else if (curbotOnSolana && curbotOnSolana?.dexId == "pumpfun") {
    let poolInfo = {
      pairAddresss: curbotOnSolana.pairAddress,
      poolType: curbotOnSolana.poolType,
      dexId: curbotOnSolana.dexId,
      feeRate: 0.01,
    }

    let isCPMM = false;

    return { baseToken, poolInfo, isCPMM };
  } else if (curbotOnSolana && curbotOnSolana?.dexId == "meteora") {
    let poolInfo = null;
    if (curbotOnSolana.poolType == "DYN") {
      poolInfo = await AmmImpl.create(connection, new PublicKey(curbotOnSolana.pairAddress));
    } else if (curbotOnSolana.poolType == "DLMM") {
      poolInfo = await DLMM.create(connection, new PublicKey(curbotOnSolana.pairAddress), { cluster: "mainnet-beta" });
    }

    let isCPMM = false;

    return { baseToken, poolInfo, isCPMM };
  }

  return { baseToken, poolInfo: null, isCPMM: false };
}

// Function 3: Update target volume based on deposit and bonus
async function updateTargetVolume(curbotOnSolana: any, poolInfo: any) {
  // Get bonus amount
  let bonusAmount: any = await database.getBonus(curbotOnSolana.userId);
  bonusAmount = Number(bonusAmount?.amount) || 0;
  console.log("[bonusAmount]: ", bonusAmount);

  // Reset targetVolume for CPMM pool
  const one_k_vol_price = ONE_K_VOL_PRICE;
  const newTargetVolume = (curbotOnSolana.depositAmount * 1000) / one_k_vol_price + bonusAmount;

  if (curbotOnSolana.targetVolume != newTargetVolume) {
    await VolumeBotModel.findByIdAndUpdate(curbotOnSolana._id, {
      targetVolume: newTargetVolume,
    });
  }

  // Additional update for SPL 2022 token
  if (curbotOnSolana.token?.is2022) {
    const mint = await getMint(connection, new PublicKey(curbotOnSolana.token.address), "confirmed", TOKEN_2022_PROGRAM_ID);
    const feeConfig = await getTransferFeeConfig(mint);

    if (feeConfig && feeConfig?.newerTransferFee) {
      let one_k_vol_price_2 = one_k_vol_price * (Number(feeConfig?.newerTransferFee?.transferFeeBasisPoints) / 10000 / 0.0025);
      console.log("one_k_vol_price_2: ", one_k_vol_price_2);

      let newTargetVolume_2 = (curbotOnSolana.depositAmount * 1000) / one_k_vol_price_2 / 1.7 +
        bonusAmount / (Number(feeConfig?.newerTransferFee?.transferFeeBasisPoints) / 10000 / 0.0025);

      console.log("newTargetVolume_2: ", newTargetVolume_2);
      await VolumeBotModel.findByIdAndUpdate(curbotOnSolana._id, {
        targetVolume: newTargetVolume_2,
      });
    }
  }

  console.log("newTargetVolume: ", newTargetVolume);
}

// Function 4: Prepare wallets and check balances
async function prepareWallets(botOnSolana: any, usedWallet: number) {
  const subWallets: Keypair[] = [];
  for (let i = 0; i < MAKER_BOT_MAX_PER_TX; i++) {
    const payerKeypair = Keypair.generate();
    subWallets.push(payerKeypair);
  }

  const mainWallet = Keypair.fromSecretKey(bs58.decode(botOnSolana.mainWallet.privateKey));
  const userBalance = await connection.getBalance(mainWallet.publicKey);
  console.log("userWallet Balance: ", userBalance);

  const mainBalance = await connection.getBalance(MAIN_WALLET.publicKey);
  console.log("MAIN_WALLET Balance: ", mainBalance);

  return { subWallets, mainWallet, userBalance, mainBalance };
}

// Function 5: Check wallet balances and alert if necessary
async function checkWalletBalances(lastSideBalance: number, sideBalance: number) {
  if (lastSideBalance - sideBalance > 0.015 * 10 ** 9) {
    // Alert admin for significant change on side wallet
    for (let j = 0; j < ADMIN_USERS.length; j++) {
      if (ADMIN_USERS[j] == 8267607372) continue;

      try {
        bot.api.sendMessage(
          ADMIN_USERS[j],
          `⚠️⚠️⚠️ Side Wallet Balance changed greatly. Might draining... \nCurrent Balance : <code>${sideBalance / (10 ** 9)}</code> SOL\nChanged Amount : <code>${(lastSideBalance - sideBalance) / (10 ** 9)}</code> SOL\nPlease check it.`,
          { parse_mode: "HTML" }
        );
      } catch (err) {
        console.log("Error in sending message to admin", err);
      }
    }
  } else if (sideBalance < 0.2 * 10 ** 9) {
    // Alert admin for low balance
    for (let j = 0; j < ADMIN_USERS.length; j++) {
      try {
        bot.api.sendMessage(
          ADMIN_USERS[j],
          `⚠️ Side Wallet Balance is too low. Please deposit more... \nCurrent Balance : <code>${sideBalance / (10 ** 9)}</code> SOL`,
          { parse_mode: "HTML" }
        );
      } catch (err) {
        console.log("Error in sending message to admin", err);
      }
    }
  }
}

// Function 6: Handle completed bot operations
async function handleCompletedBot(botOnSolana: any, curbotOnSolana: any, profitAmount: any, baseToken: Token, poolInfo: any, quoteToken: Token, isCPMM: boolean) {
  console.log("Volume Made is greater than target volume or userWallet balance is low. Stopping volume bot.");
  await volumeBotUpdateStatus(botOnSolana._id, BOT_STATUS.ARCHIVED_TARGET_VOLUME);

  const mainWallet = Keypair.fromSecretKey(bs58.decode(botOnSolana.mainWallet.privateKey));

  // Sell left tokens in the last swap
  await new Promise((resolve) => setTimeout(resolve, 15000));
  let txn = null;
  if (curbotOnSolana && curbotOnSolana?.dexId == "raydium") {
    txn = await makeSellTransactionRaydium(
      connection,
      mainWallet,
      quoteToken,
      baseToken,
      botOnSolana.token.decimals,
      poolInfo,
      raydiumSDKList.get(mainWallet.publicKey.toString()),
      botOnSolana.addressLookupTable
    );
  } else if (curbotOnSolana && curbotOnSolana?.dexId == "pumpswap") {
    // rest sell transaction
  } else if (curbotOnSolana && curbotOnSolana?.dexId == "pumpfun") {
    // rest sell transaction
  }

  if (txn) {
    let volTx = txn?.volTx;
    let isSell = txn?.isSell;

    if (volTx) {
      const signers = [];
      const versionedTx = [];

      versionedTx.push(volTx);
      signers.push([mainWallet]);

      await updateRecentBlockHash(connection, versionedTx);
      for (let i = 0; i < versionedTx.length; i++) {
        if (versionedTx[i])
          versionedTx[i].sign(signers[i]);
      }

      console.log("sell rest tokens in the wallet...");

      let ret = await createAndSendBundleEx(connection, mainWallet, versionedTx);
      if (ret) {
        console.log("Rest token selling suceed.");
      } else {
        console.log("Rest token selling failed.");
      }
    }
  }

  // Use bonus
  await database.useBonus(curbotOnSolana.userId);

  // Check pending users and enable next in queue
  const pendingUsers = await VolumeBotModel.find({ $and: [{ enable: true }, { isPending: true }] });
  if (pendingUsers.length > 0) {
    console.log("pendingUsers[0].userId: ", pendingUsers[0].userId);
    await VolumeBotModel.findOneAndUpdate({ userId: pendingUsers[0].userId }, {
      isPending: false
    });
  }

  // Send completion notifications
  const logoPath = path.join(__dirname, '../assets/logo.jpg');
  bot.api.sendPhoto(
    botOnSolana.userId,
    new InputFile(logoPath),
    {
      caption: `🔥 ${process.env.BOT_TITLE} is done!`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          // [{ text: '🚀 Start', callback_data: 'start' }],
          [{ text: '❌ Close', callback_data: 'close' }],
        ]
      },
    }
  );

  // alertToAdmins(finishMsg);

  // notify to channel
  notifyToChannel(
    `Finished 🏁\n
  Chart: <a href="https://dexscreener.com/solana/${botOnSolana?.token?.address}">${botOnSolana?.token?.name}</a>
  Client: @${sessions.get(botOnSolana?.userId)?.username} (<code>${botOnSolana?.userId}</code>) 
  Plan: ${botOnSolana?.targetVolume} volume
  Max Buy: ${botOnSolana?.maxBuy} SOL
  Speed: ${botOnSolana?.delayTime} sec`
  );
}

// Function 7: Prepare transactions for volume making
async function prepareTransactions(botOnSolana: any, curbotOnSolana: any, isCPMM: boolean, mainBalance: number, sideBalance: number, subWallets: any, baseToken: Token, quoteToken: Token, poolInfo: any, sideBuy: boolean) {
  // Get updated pool info and sol price
  // let sol_price = Number((await getSolanaPriceBinance())?.price);

  // if (curbotOnSolana && curbotOnSolana?.dexId == "raydium") {
  //   poolInfo = await getPoolInfo(
  //     connection2,
  //     quoteToken,
  //     baseToken,
  //     raydiumSDKList.get(curbotOnSolana.mainWallet.publicKey.toString()),
  //   );

  //   if (!poolInfo) {
  //     throw new Error("[Volume] Can't get pool info");
  //   }
  // } else if (curbotOnSolana && curbotOnSolana?.dexId == "meteora") {
  //   if (curbotOnSolana.poolType == "DYN") {
  //     poolInfo = await AmmImpl.create(connection, new PublicKey(curbotOnSolana.pairAddress));
  //   } else if (curbotOnSolana.poolType == "DLMM") {
  //     poolInfo = await DLMM.create(connection, new PublicKey(curbotOnSolana.pairAddress), { cluster: "mainnet-beta" });
  //   }
  // }

  // Calculate max buy amount
  let maxBuyAmount = Number(botOnSolana.maxBuy) * LAMPORTS_PER_SOL;
  if (maxBuyAmount >= (Number((mainBalance) / 4))) {
    maxBuyAmount = Number((mainBalance) / 4);
    console.log("Max Buy Amount is too high. Set to 1/4 of main balance: ", maxBuyAmount / LAMPORTS_PER_SOL, mainBalance / LAMPORTS_PER_SOL);
  }

  if (curbotOnSolana && curbotOnSolana?.dexId == "raydium") {
    // Adjust max buy amount based on liquidity
    const lpSize = poolInfo?.lpPrice * poolInfo?.lpAmount;
    if (lpSize != null && lpSize > 0) {
      let multiplier = 1;
      if (lpSize < 2000) {
        multiplier = 3;
      } else if (lpSize < 5000) {
        multiplier = 2.4;
      } else if (lpSize < 9000) {
        multiplier = 1.9;
      } else if (lpSize < 15000) {
        multiplier = 1.5;
      } else if (lpSize < 30000) {
        multiplier = 1.2;
      }

      let rate = lpSize / (SOL_PRICE * Number(botOnSolana.maxBuy) * 4.5 * multiplier * 6);
      if (rate < 1)
        maxBuyAmount = maxBuyAmount * rate;

      console.log("Rate: ", rate, "lpSize: ", lpSize, "Sol Price: ", SOL_PRICE);
    }
  }

  if (sideBuy) {
    maxBuyAmount = randomInt(1, 10) * LAMPORTS_PER_SOL / 100000;
  }

  console.log(sideBuy ? "==> SIDE BUY" : "==> MAIN BUY");
  console.log("===> Final Max Buy Amount : ", maxBuyAmount / LAMPORTS_PER_SOL);

  // Prepare transaction arrays
  let distSolArr = [];
  let minOutArr = [];
  let newMadeVolume = 0;
  const signers = [];
  const pattern = selectTradingPattern();
  console.log(`Selected pattern: ${pattern.buyCount} buys, ${pattern.sellCount} sells`);

  // Initialize amounts for buy transactions
  for (let i = 0; i < pattern.buyCount; i++) {
    const randfactor = getRandomNumber(0.9, 0.95, 2);
    console.log("Buy Sol Amount:", randfactor * maxBuyAmount / LAMPORTS_PER_SOL);
    console.log(`SOL Price: ${SOL_PRICE}`);
    if (curbotOnSolana && curbotOnSolana?.dexId == "pumpswap") {
      newMadeVolume += randfactor * maxBuyAmount / LAMPORTS_PER_SOL * SOL_PRICE * 1.9;
    } else {
      newMadeVolume += randfactor * maxBuyAmount / LAMPORTS_PER_SOL * SOL_PRICE * 1.8;
    }
    distSolArr.push(randfactor * maxBuyAmount);
    minOutArr.push(new BN(0));
  }

  console.log('✅✅✅Estimated New Made Volume for this bundle: ', newMadeVolume);

  const versionedTx = [];
  let sellCount = 0;
  const mainWallet = Keypair.fromSecretKey(bs58.decode(botOnSolana.mainWallet.privateKey));
  const userBalance = await connection.getBalance(mainWallet.publicKey);
  console.log("User Wallet Address : ", mainWallet.publicKey.toBase58(), userBalance);

  // add funds to new fresh wallets
  const fundingIxs: TransactionInstruction[] = [];
  for (let i = 0; i < MAKER_BOT_MAX_PER_TX; i++) {
    fundingIxs.push(
      SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: subWallets[i].publicKey,
        lamports: 890880 + 10000,
      })
    );

    // store the new wallet in the database
    await zombieModel.create({
      publickey: subWallets[i].publicKey.toBase58(),
      privatekey: bs58.encode(subWallets[i].secretKey),
      type: "volume"
    });
  }

  // add referral tax instruction to the fundingIxs
  const user: any = await database.selectUser({ chatid: botOnSolana.userId });
  const referral = user?.referredBy;

  if (referral) {
    const referralUser: any = await database.selectUser({ chatid: referral });
    const referralWallet = Keypair.fromSecretKey(bs58.decode(referralUser.depositWallet));

    const referralTaxInstruction = getReferralTaxInstruction(referralWallet.publicKey, mainWallet, distSolArr[0] * 4);
    fundingIxs.push(...referralTaxInstruction);
  }

  const fundingTx = await makeVersionedTransactionsWithMultiSign(connection, [mainWallet], fundingIxs);

  versionedTx.push(fundingTx);
  signers.push([mainWallet]);

  // Generate sell positions randomly
  const sellPositions = new Set();
  while (sellPositions.size < pattern.sellCount - 1) {
    const position = Math.floor(Math.random() * pattern.buyCount);
    sellPositions.add(position);
  }
  sellPositions.add(pattern.buyCount - 1);  // last position must sell token

  // Create transactions
  for (let i = 0; i < pattern.buyCount; i++) {
    try {
      if (curbotOnSolana && curbotOnSolana?.dexId == "raydium") {
        const { volTx, isSell } = await makeBuySellTransactionRaydiumVolume(
          connection,
          subWallets[i],
          mainWallet,
          distSolArr[i],
          minOutArr,
          quoteToken,
          baseToken,
          botOnSolana.token.decimals,
          poolInfo,
          raydiumSDKList.get(mainWallet.publicKey.toString()),
          i,
          sellPositions.has(i),
          botOnSolana.addressLookupTable
        );

        if (isSell) {
          sellCount++;
        }

        if (!volTx) {
          continue;
        }

        versionedTx.push(volTx);
        signers.push([mainWallet, subWallets[i]]);
      } else if (curbotOnSolana && curbotOnSolana?.dexId == "pumpswap") {
        const { volTx, isSell } = await makeBuySellTransactionPumpswapVolume(
          connection,
          new PublicKey(curbotOnSolana.pairAddress),
          subWallets[i],
          mainWallet,
          new BN(distSolArr[i]),
          minOutArr,
          baseToken,
          botOnSolana.token.decimals,
          i,
          sellPositions.has(i),
          botOnSolana.addressLookupTable
        );
        console.log(`-----> Pumpswap Volume Tx for wallet ${i}: isSell: ${isSell}`);

        if (isSell) {
          sellCount++;
        }

        if (!volTx) {
          continue;
        }

        versionedTx.push(volTx);
        signers.push([mainWallet, subWallets[i]]);
      } else if (curbotOnSolana && curbotOnSolana?.dexId == "pumpfun") {
        const { volTx, isSell } = await makeBuySellTransactionPumpFunVolume(
          connection,
          new PublicKey(curbotOnSolana.token.address),
          subWallets[i],
          mainWallet,
          new BN(distSolArr[i]),
          minOutArr,
          i,  // walletNum
          sellPositions.has(i),  // shouldSell
          botOnSolana.addressLookupTable,
          curbotOnSolana.token?.is2022 || false,
        );

        if (isSell) {
          sellCount++;
        }

        if (!volTx) {
          continue;
        }

        versionedTx.push(volTx);
        signers.push([mainWallet, subWallets[i]]);
      } else if (curbotOnSolana && curbotOnSolana?.dexId == "meteora") {
        const { volTx, isSell } = await makeBuySellTransactionMeteoraVolume(
          connection,
          poolInfo,
          botOnSolana.poolType,
          subWallets[i],
          mainWallet,
          new BN(distSolArr[i]),
          minOutArr,
          i,  // walletNum
          sellPositions.has(i),  // shouldSell
          botOnSolana.addressLookupTable,
        );

        if (isSell) {
          sellCount++;
        }

        if (!volTx) {
          continue;
        }

        versionedTx.push(volTx);
        signers.push([mainWallet, subWallets[i]]);
      }
    } catch (err) {
      console.log(err);
    }
  }

  return {
    maxBuyAmount,
    newMadeVolume,
    transactions: {
      versionedTx,
      signers,
      sellCount
    }
  };
}

// Function 8: Execute transactions and update stats
async function executeTransactions(connection: Connection, wallet: Keypair, versionedTx: VersionedTransaction[], delayTime: number, botOnSolana: any, newMadeVolume: number, sellCount: number) {
  // // send each versioned transaction
  // console.log("Executing transactions...", versionedTx.length);
  // for (let i = 0; i < versionedTx.length; i++) {
  //   if (versionedTx[i]) {
  //     try {
  //       console.log("Sending transaction ", i);
  //       const txid = await connection.sendTransaction(versionedTx[i], {
  //         skipPreflight: false,
  //         preflightCommitment: "confirmed",
  //       });
  //       console.log("Transaction sent successfully: ", txid, i);

  //       const ret = await connection.confirmTransaction(
  //         txid,
  //         "confirmed"
  //       );
  //       console.log("Transaction confirmed: ", ret, i);
  //     } catch (err) {
  //       console.log("Error sending transaction: ", err, i);
  //     }
  //   }
  // }

  // await new Promise((resolve) => setTimeout(resolve, 100000));
  // return true;
  if (delayTime > 30) {
    const bundleResult = await createAndSendBundleEx(connection, wallet, versionedTx);

    if (bundleResult) {
      const updatedBot = await VolumeBotModel.findOne({
        userId: botOnSolana.userId,
      });

      console.log("✅ New Made Volume: ", newMadeVolume);

      const volumeMade = Number(updatedBot?.volumeMade) + newMadeVolume;

      /**************** Bonus Logic ************************ */
      const preIndex = Number(updatedBot?.volumeMade) / BONUS_THRESHOLD;
      const newIndex = volumeMade / BONUS_THRESHOLD;
      // Give bonus if crossed threshold
      if (Math.floor(newIndex) > Math.floor(preIndex)) {
        const bonusWalletKeypair = Keypair.fromSecretKey(
          bs58.decode(BONUS_WALLET)
        );
        console.log(`✅✅✅ Giving bonus to ${wallet.publicKey.toBase58()}`);
        const bonusTx = new Transaction();
        let bonusAmount = 0;
        switch (Math.floor(newIndex)) {
          case 1:
            bonusAmount = 0.001;
            break;
          case 5:
            bonusAmount = 0.002;
            break;
          case 10:
            bonusAmount = 0.003;
            break;
          case 30:
            bonusAmount = 0.005;
            break;
          case 50:
            bonusAmount = 0.007;
          default:
            bonusAmount = 0;
            break;
        }
        if (bonusAmount > 0) {
          bonusTx.add(
            SystemProgram.transfer({
              fromPubkey: bonusWalletKeypair.publicKey,
              toPubkey: wallet.publicKey,
              lamports: bonusAmount * LAMPORTS_PER_SOL,
            })
          );

          const txSignature = await sendAndConfirmTransaction(
            connection,
            bonusTx,
            [bonusWalletKeypair]
          );

          // Send notification to user about bonus received
          try {
            await bot.api.sendMessage(
              botOnSolana.userId,
              `🎉 <b>Bonus Received!</b>\n\n` +
                `You've received a bonus of <code>${bonusAmount}</code> SOL for reaching ${formatNumberWithUnit(
                  Math.floor(newIndex) * BONUS_THRESHOLD
                )} volume!\n\n` +
                `Transaction: <code>${txSignature}</code>`,
              { parse_mode: "HTML" }
            );
          } catch (err) {
            console.log("Error sending bonus notification to user:", err);
          }
        }
      }
      
      const makerMade = Number(updatedBot?.makerMade) + MAKER_BOT_MAX_PER_TX;
      const txDone = Number(updatedBot?.txDone) + MAKER_BOT_MAX_PER_TX + sellCount;

      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        volumeMade,
        makerMade,
        txDone,
        status: volumeMade >= botOnSolana?.targetVolume ? BOT_STATUS.ARCHIVED_TARGET_VOLUME : BOT_STATUS.RUNNING,
      });

      // Sleep after successful transaction
      // console.log("sleeping seconds: ", delayTime - 30);
      // await sleep((delayTime - 30) * 1000); // Subtract checkbundle time
      return true;
    } else {
      console.log("❌ Bundle failed with delayTime", delayTime, "- retrying immediately");
      return false;
    }
  } else {
    // For short delays, fire and forget
    createAndSendBundleEx(connection, wallet, versionedTx)
      .then(async (ret) => {
        if (ret) {
          const updatedBot = await VolumeBotModel.findOne({
            userId: botOnSolana.userId,
          });

          console.log("✅ New Made Volume: ", newMadeVolume);

          const volumeMade = Number(updatedBot?.volumeMade) + newMadeVolume;

          /**************** Bonus Logic ************************ */
          const preIndex = Number(updatedBot?.volumeMade) / BONUS_THRESHOLD;
          const newIndex = volumeMade / BONUS_THRESHOLD;
          // Give bonus if crossed threshold
          if (Math.floor(newIndex) > Math.floor(preIndex)) {
            const bonusWalletKeypair = Keypair.fromSecretKey(
              bs58.decode(BONUS_WALLET)
            );
            console.log(`✅✅✅ Giving bonus to ${wallet.publicKey.toBase58()}`);
            const bonusTx = new Transaction();
            let bonusAmount = 0;
            switch (Math.floor(newIndex)) {
              case 1:
                bonusAmount = 0.001;
                break;
              case 5:
                bonusAmount = 0.002;
                break;
              case 10:
                bonusAmount = 0.003;
                break;
              case 30:
                bonusAmount = 0.005;
                break;
              case 50:
                bonusAmount = 0.007;
              default:
                bonusAmount = 0;
                break;
            }
            if (bonusAmount > 0) {
              bonusTx.add(
                SystemProgram.transfer({
                  fromPubkey: bonusWalletKeypair.publicKey,
                  toPubkey: wallet.publicKey,
                  lamports: bonusAmount * LAMPORTS_PER_SOL,
                })
              );

              const txSignature = await sendAndConfirmTransaction(
                connection,
                bonusTx,
                [bonusWalletKeypair]
              );

              // Send notification to user about bonus received
              try {
                await bot.api.sendMessage(
                  botOnSolana.userId,
                  `🎉 <b>Bonus Received!</b>\n\n` +
                    `You've received a bonus of <code>${bonusAmount}</code> SOL for reaching ${formatNumberWithUnit(
                      Math.floor(newIndex) * BONUS_THRESHOLD
                    )} volume!\n\n` +
                    `Transaction: <code>${txSignature}</code>`,
                  { parse_mode: "HTML" }
                );
              } catch (err) {
                console.log("Error sending bonus notification to user:", err);
              }
            }
          }

          const makerMade = Number(updatedBot?.makerMade) + MAKER_BOT_MAX_PER_TX;
          const txDone = Number(updatedBot?.txDone) + MAKER_BOT_MAX_PER_TX + sellCount;

          await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
            volumeMade,
            makerMade,
            txDone,
            status: volumeMade >= Number(updatedBot?.targetVolume) ? BOT_STATUS.ARCHIVED_TARGET_VOLUME : BOT_STATUS.RUNNING,
          });
        }
      });
    return true;
  }
}
