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
  quoteToken as DEFAULT_QUOTE_TOKEN,
  raydiumSDKList,
  MAKER_BOT_MAX_PER_TX,
  volumeBots,
  ADMIN_USERS,
  MAX_BUNDLE_FAILED_COUNT,
  MIN_REMAIN_SOL,
  ONE_K_VOL_PRICE,
  BONUS_THRESHOLD,
  BONUS_WALLET,
  getQuoteToken,
  getQuoteUsdPrice,
  isUSD1Quote,
  USD1_MINT,
  USD1_TOKEN,
  WSOL_MINT,
} from "./const";
import { SystemProgram } from "@solana/web3.js";
import { sleep } from "../utils/common";
import * as path from 'path';
import { randomInt } from "crypto";
import { Connection } from "@solana/web3.js";
import { TransactionInstruction } from "@solana/web3.js";
import { buyToken as raydiumBuyToken, buyTokenInstructionRaydium, createTokenAccountTxRaydium, makeBuySellTransactionRaydiumVolume, makeSellTransactionRaydium, sellToken as raydiumSellToken } from "../dexs/raydium";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID } from "@solana/spl-token";
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

// ============================================================================
// USD1 quote-token support
// ============================================================================
//
// When the user selects a USD1 pool (TOKEN/USD1), the sub-wallets still need
// to pay rent/Jito tips in SOL, but the *swap input* has to be USD1. Users
// only deposit SOL into the main wallet, so the bot has to bootstrap its own
// USD1 balance by swapping a chunk of SOL → USD1 once (and refills as needed).
// Sub-wallets are then topped up with USD1 via SPL transfers each iteration,
// analogous to the current SOL rent transfer.

// Cleanup on bot completion: leftover USD1 on the main wallet is swapped back
// to SOL so withdrawal stays a single-asset flow.

const USD1_BOOTSTRAP_MULT = 6; // swap enough SOL→USD1 to cover ~N iterations
const USD1_REFILL_THRESHOLD_MULT = 1.5; // refill when balance < maxBuy * this

async function getMainWalletUsd1Balance(mainWalletPubkey: PublicKey): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(USD1_MINT), mainWalletPubkey, false, SPL_TOKEN_PROGRAM_ID);
    const acc = await getAccount(connection, ata, "confirmed", SPL_TOKEN_PROGRAM_ID);
    return Number(acc.amount);
  } catch {
    return 0;
  }
}

/**
 * Build SOL → USD1 swap instructions for in-bundle refill, instead of sending
 * a separate standalone transaction. Used by prepareTransactions to prepend
 * the swap to the funding transaction so the refill and the sub-wallet rent
 * transfers land atomically in the same Jito bundle slot.
 *
 * Contract:
 * - Returns `{ ixs: [], minOut: 0 }` when no refill is needed (current balance
 *   already >= target). Caller should treat this as a no-op.
 * - Returns `{ ixs, minOut }` with the swap ixs when refill is needed and
 *   successfully built.
 * - Returns `null` on hard failure (no pool, SDK init failed, SOL reserve
 *   clamp triggered with no spendable SOL, etc). Caller decides whether to
 *   proceed without the refill or abort the iteration.
 *
 * The SOL reserve clamp from ensureMainWalletUsd1Balance is preserved so the
 * wallet always keeps enough SOL for tx fees, Jito tips, and sub-wallet rent.
 */
async function buildRefillSolToUsd1Ixs(
  mainWallet: Keypair,
  targetUsd1Raw: number
): Promise<{ ixs: TransactionInstruction[]; minOut: BN } | null> {
  try {
    const currentRaw = await getMainWalletUsd1Balance(mainWallet.publicKey);
    if (currentRaw >= targetUsd1Raw) {
      return { ixs: [], minOut: new BN(0) };
    }

    const needed = targetUsd1Raw - currentRaw; // raw USD1 (6 decimals)
    const solNeeded = (needed / 1e6) / Math.max(SOL_PRICE, 1);
    // 3% buffer for slippage + fees
    let solToSwap = Math.ceil(solNeeded * 1.03 * LAMPORTS_PER_SOL);

    const currentSolLamports = await connection.getBalance(mainWallet.publicKey);
    const reserveLamports = Math.ceil(MIN_REMAIN_SOL * LAMPORTS_PER_SOL);
    const spendable = currentSolLamports - reserveLamports;
    if (spendable <= 0) {
      console.log(`[USD1] Main wallet has ${currentSolLamports / LAMPORTS_PER_SOL} SOL <= reserve ${MIN_REMAIN_SOL}; cannot refill USD1 in-bundle.`);
      return null;
    }
    if (solToSwap > spendable) {
      console.log(`[USD1] Clamping in-bundle refill: needed ${solToSwap / LAMPORTS_PER_SOL} SOL, spendable ${spendable / LAMPORTS_PER_SOL} SOL (reserve ${MIN_REMAIN_SOL} SOL)`);
      solToSwap = spendable;
    }

    await addRaydiumSDK(mainWallet.publicKey);
    const raydium = raydiumSDKList.get(mainWallet.publicKey.toString());
    if (!raydium) {
      console.log("[USD1] Raydium SDK init failed for main wallet (in-bundle refill)");
      return null;
    }

    const solUsd1Pool = await getPoolInfo(
      connection2,
      DEFAULT_QUOTE_TOKEN, // WSOL
      USD1_TOKEN,          // USD1 (base/target)
      raydium,
      "amm"
    );
    if (!solUsd1Pool || !solUsd1Pool.id) {
      console.log("[USD1] No Raydium SOL/USD1 pool found (in-bundle refill)");
      return null;
    }

    const { instructions, minOut } = await buyTokenInstructionRaydium(
      connection,
      mainWallet,
      solToSwap,
      DEFAULT_QUOTE_TOKEN,
      USD1_TOKEN,
      solUsd1Pool,
      raydium
    );

    if (!instructions || instructions.length === 0) {
      console.log("[USD1] In-bundle refill: buyTokenInstructionRaydium returned no ixs");
      return null;
    }

    console.log(`[USD1] In-bundle refill prepared: spending ${solToSwap / LAMPORTS_PER_SOL} SOL → USD1, minOut=${minOut?.toString?.() ?? minOut}, ixs=${instructions.length}`);
    return { ixs: instructions, minOut: new BN(minOut) };
  } catch (err) {
    console.error("[USD1] buildRefillSolToUsd1Ixs failed:", err);
    return null;
  }
}

/**
 * Swap any remaining USD1 on the main wallet back to SOL. Used on bot
 * completion so the user's withdraw flow stays SOL-only.
 */
async function liquidateMainWalletUsd1ToSol(mainWallet: Keypair): Promise<boolean> {
  try {
    const balanceRaw = await getMainWalletUsd1Balance(mainWallet.publicKey);
    if (balanceRaw <= 0) return true;

    // Keep a tiny dust reserve to avoid closing-account edge cases.
    const toSell = balanceRaw - 1;
    if (toSell <= 0) return true;

    await addRaydiumSDK(mainWallet.publicKey);
    const raydium = raydiumSDKList.get(mainWallet.publicKey.toString());
    if (!raydium) return false;

    const solUsd1Pool = await getPoolInfo(
      connection2,
      DEFAULT_QUOTE_TOKEN,
      USD1_TOKEN,
      raydium,
      "amm"
    );
    if (!solUsd1Pool || !solUsd1Pool.id) return false;

    const res = await raydiumSellToken(
      connection,
      mainWallet,
      new BN(toSell),
      DEFAULT_QUOTE_TOKEN,
      USD1_TOKEN,
      solUsd1Pool,
      raydium
    );

    if (!res || !res.transaction) return false;

    const sig = await connection.sendTransaction(res.transaction, { skipPreflight: false, preflightCommitment: "confirmed" });
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`[USD1] Liquidated ${toSell / 1e6} USD1 → SOL: ${sig}`);
    return true;
  } catch (err) {
    console.error("[USD1] liquidateMainWalletUsd1ToSol failed:", err);
    return false;
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
  let works = 0;

  // Per-bot quote token (WSOL by default, USD1 if the user picked a USD1 pool).
  // Local `quoteToken` shadows what used to be a global import so existing
  // call-sites inside this function keep compiling unchanged.
  const quoteToken = getQuoteToken(curbotOnSolana);
  const usesUSD1 = isUSD1Quote(curbotOnSolana);

  // Initialize token and pool
  const { baseToken, poolInfo, isCPMM } = await initializeTokenAndPool(curbotOnSolana);
  if (!poolInfo) {
    console.log("[Volume] Can't get pool info of tokens", curbotOnSolana.token.address);
    volumeBots.delete(curbotOnSolana._id.toString());
    return;
  }

  while (running) {
    // Get latest bot info from database
    const botOnSolana = await VolumeBotModel.findOne({
      userId: curbotOnSolana.userId,
    })
      .populate("mainWallet token targetVolume enable usedWallet volumeMade delayTime maxBuy workedSeconds workingTime txDone startSolAmount")
      .lean();

    if (!botOnSolana || botOnSolana.enable == false || initialBundleFailedCount > MAX_BUNDLE_FAILED_COUNT) {
      break;
    }

    // Extract bot parameters
    let { workedSeconds = 0, delayTime = 0, volumeMade = 0, txDone = 0,
      targetVolume = 0, usedWallet = 0, startSolAmount = 0, workingTime = 0 } = botOnSolana;
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
          curbotOnSolana.token?.is2022,
          usesUSD1,
          botOnSolana.addressLookupTable || ""
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

      // Stop when remaining balance is below threshold
      if (!sideBuy) {
        // Check if working time limit exceeded
        if (workingTime > 0 && works >= workingTime) {
          console.log("✅✅✅ Working time limit exceeded, stopping volume bot.");
          await handleCompletedBot(botOnSolana, curbotOnSolana, profitAmount, baseToken, poolInfo, quoteToken, isCPMM);
          await volumeBotUpdateStatus(botOnSolana._id, BOT_STATUS.EXPIRED_WORKING_TIME);
          break;
        }

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
      workedSeconds = Number(workedSeconds) + Number(newSpentSeconds) + delayTime;
      works = works + Number(newSpentSeconds) + delayTime;

      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        workedSeconds: workedSeconds,
      });

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
  let works = 0;

  // Pumpswap is SOL-only — the quote is always WSOL.
  const quoteToken = DEFAULT_QUOTE_TOKEN;

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
      .populate("mainWallet token targetVolume enable usedWallet volumeMade delayTime maxBuy workedSeconds workingTime txDone startSolAmount")
      .lean();

    if (!botOnSolana || botOnSolana.enable == false || initialBundleFailedCount > MAX_BUNDLE_FAILED_COUNT) {
      break;
    }

    // Extract bot parameters
    let { workedSeconds = 0, delayTime = 0, volumeMade = 0, txDone = 0,
      targetVolume = 0, usedWallet = 0, startSolAmount = 0, workingTime = 0 } = botOnSolana;
    let newSpentSeconds = 0;

    console.log(`✅✅✅✅✅ workedSeconds: ${works}, workingTime: ${workingTime},`)

    try {
      const startTime = Date.now();

      // Get wallets and check balances
      const { subWallets, mainWallet, userBalance, mainBalance } = await prepareWallets(botOnSolana, usedWallet);

      const profitAmount = (Number(mainBalance - startSolAmount) / 10 ** 9) + Number(MIN_REMAIN_SOL);

      // Stop when targe volume reached or remaining balance is below threshold
      if (!sideBuy) {
        // Check if working time limit exceeded
        if (workingTime > 0 && works >= workingTime) {
          console.log(`✅✅✅ Working time limit exceeded (${works}s >= ${workingTime}s), stopping volume bot.`);
          await handleCompletedBot(botOnSolana, curbotOnSolana, profitAmount, baseToken, poolInfo, quoteToken, isCPMM);
          await volumeBotUpdateStatus(botOnSolana._id, BOT_STATUS.EXPIRED_WORKING_TIME);
          break;
        }

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

      // Create Token Account for PumpFun
      const lookupTableAddress = await createTokenAccountTxPumpswap(
        connection,
        mainWallet,
        baseToken.mint,
        curbotOnSolana.token?.is2022,
        botOnSolana.addressLookupTable || "",
        new PublicKey(curbotOnSolana.pairAddress)
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
      workedSeconds = Number(workedSeconds) + Number(newSpentSeconds) + delayTime;
      works = works + Number(newSpentSeconds) + delayTime;

      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        workedSeconds: workedSeconds,
      });

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
  let works = 0;

  // Pumpfun is SOL-only — the quote is always WSOL.
  const quoteToken = DEFAULT_QUOTE_TOKEN;

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
      .populate("mainWallet token targetVolume enable usedWallet volumeMade delayTime maxBuy workedSeconds workingTime txDone startSolAmount")
      .lean();

    if (!botOnSolana || botOnSolana.enable == false || initialBundleFailedCount > MAX_BUNDLE_FAILED_COUNT) {
      break;
    }

    // Extract bot parameters
    let { workedSeconds = 0, delayTime = 0, volumeMade = 0, txDone = 0,
      targetVolume = 0, usedWallet = 0, startSolAmount = 0, workingTime = 0 } = botOnSolana;
    let newSpentSeconds = 0;

    try {
      const startTime = Date.now();

      // Get wallets and check balances
      const { subWallets, mainWallet, userBalance, mainBalance } = await prepareWallets(botOnSolana, usedWallet);

      const profitAmount = (Number(mainBalance - startSolAmount) / 10 ** 9) + Number(MIN_REMAIN_SOL);

      // Stop when target volume reached or remaining balance is below threshold
      if (!sideBuy) {
        // Check if working time limit exceeded
        if (workingTime > 0 && works >= workingTime) {
          console.log(`✅✅✅ Working time limit exceeded (${works}s >= ${workingTime}s), stopping volume bot.`);
          await handleCompletedBot(botOnSolana, curbotOnSolana, profitAmount, baseToken, poolInfo, quoteToken, isCPMM);
          await volumeBotUpdateStatus(botOnSolana._id, BOT_STATUS.EXPIRED_WORKING_TIME);
          break;
        }

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

      // Create Token Account for PumpFun
      const lookupTableAddress = await createTokenAccountTxPumpFun(
        connection,
        mainWallet,
        baseToken.mint,
        baseToken.programId.equals(TOKEN_2022_PROGRAM_ID),
        botOnSolana.addressLookupTable || ""
      );

      if (lookupTableAddress) {
        botOnSolana.addressLookupTable = lookupTableAddress.toString();
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
      workedSeconds = Number(workedSeconds) + Number(newSpentSeconds) + delayTime;
      works = works + Number(newSpentSeconds) + delayTime;

      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        workedSeconds: workedSeconds,
      });

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
  let works = 0;

  // Meteora volume path currently assumes SOL as the quote.
  const quoteToken = DEFAULT_QUOTE_TOKEN;

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
      .populate("mainWallet token targetVolume enable usedWallet volumeMade delayTime maxBuy workedSeconds workingTime txDone startSolAmount")
      .lean();

    if (!botOnSolana || botOnSolana.enable == false || initialBundleFailedCount > MAX_BUNDLE_FAILED_COUNT) {
      break;
    }

    // Extract bot parameters
    let { workedSeconds = 0, delayTime = 0, volumeMade = 0, txDone = 0,
      targetVolume = 0, usedWallet = 0, startSolAmount = 0, workingTime = 0 } = botOnSolana;
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
      workedSeconds = Number(workedSeconds) + Number(newSpentSeconds) + delayTime;
      works = works + Number(newSpentSeconds) + delayTime;

      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        workedSeconds: workedSeconds,
      });

      // Stop when targetVolume reached or remaining balance is below threshold
      if (!sideBuy) {
        // Check if working time limit exceeded
        if (workingTime > 0 && works >= workingTime) {
          console.log(`✅✅✅ Working time limit exceeded (${works}s >= ${workingTime}s), stopping volume bot.`);
          await handleCompletedBot(botOnSolana, curbotOnSolana, profitAmount, baseToken, poolInfo, quoteToken, isCPMM);
          await volumeBotUpdateStatus(botOnSolana._id, BOT_STATUS.EXPIRED_WORKING_TIME);
          break;
        }

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

  // Per-bot quote token — SOL pools resolve to WSOL, USD1 pools to USD1.
  const quoteToken = getQuoteToken(curbotOnSolana);

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

// Function 4: Select wallets from database (80% reused, 20% new)
async function selectWalletsFromPool(userId: number, count: number): Promise<Keypair[]> {
  const selectedWallets: Keypair[] = [];
  
  // Get total count of zombie wallets for this user
  const totalZombieWallets = await zombieModel.countDocuments({ type: "volume", userId: userId });
  console.log(`Total zombie wallets for user ${userId}: ${totalZombieWallets}`);

  // Calculate 80% from DB and 20% new
  const reusedCount = Math.floor(count * 0.8);
  const newCount = count - reusedCount;

  // Only use database wallets if we have at least 10
  if (totalZombieWallets >= 10) {
    // Randomly select 80% from database
    const sampleSize = Math.min(reusedCount, totalZombieWallets);
    const dbWallets = await zombieModel.aggregate([
      { $match: { type: "volume", userId: userId } },
      { $sample: { size: sampleSize } }
    ]);

    // Convert to Keypair objects
    for (const dbWallet of dbWallets) {
      try {
        const keypair = Keypair.fromSecretKey(bs58.decode(dbWallet.privatekey));
        selectedWallets.push(keypair);
      } catch (err) {
        console.error("Error loading wallet from database:", err);
      }
    }

    // Generate 20% new wallets
    console.log(`Generating ${newCount} new wallets (20%)`);
    for (let i = 0; i < newCount; i++) {
      const newWallet = Keypair.generate();
      selectedWallets.push(newWallet);
      
      // Save to database with userId
      await zombieModel.create({
        publickey: newWallet.publicKey.toBase58(),
        privatekey: bs58.encode(newWallet.secretKey),
        type: "volume",
        userId: userId
      });
    }

    console.log(`Selected ${dbWallets.length} wallets from database (80%) and generated ${newCount} new wallets (20%)`);
  } else {
    // Not enough wallets in DB, generate all new ones
    console.log(`Not enough wallets in database (${totalZombieWallets} < 50), generating ${count} new wallets`);
    for (let i = 0; i < count; i++) {
      const newWallet = Keypair.generate();
      selectedWallets.push(newWallet);
      
      // Save to database with userId
      await zombieModel.create({
        publickey: newWallet.publicKey.toBase58(),
        privatekey: bs58.encode(newWallet.secretKey),
        type: "volume",
        userId: userId
      });
    }
  }

  // Shuffle the wallets array to randomize order (Fisher-Yates shuffle)
  for (let i = selectedWallets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [selectedWallets[i], selectedWallets[j]] = [selectedWallets[j], selectedWallets[i]];
  }

  return selectedWallets;
}

// Function 4.5: Prepare wallets and check balances
async function prepareWallets(botOnSolana: any, usedWallet: number) {
  // Select wallets from database or generate new ones (80% DB, 20% new)
  const subWallets = await selectWalletsFromPool(botOnSolana.userId, MAKER_BOT_MAX_PER_TX);

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

  // For USD1 bots, convert any remaining USD1 on the main wallet back to SOL
  // so the user's normal SOL withdraw flow keeps working.
  if (isUSD1Quote(botOnSolana)) {
    await liquidateMainWalletUsd1ToSol(mainWallet);
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
  const qSymbolFinished = botOnSolana?.quoteTokenSymbol || "SOL";
  notifyToChannel(
    `Finished 🏁\n
  Chart: <a href="https://dexscreener.com/solana/${botOnSolana?.token?.address}">${botOnSolana?.token?.name}</a>
  Client: @${sessions.get(botOnSolana?.userId)?.username} (<code>${botOnSolana?.userId}</code>)
  Plan: ${botOnSolana?.targetVolume} volume
  Max Buy: ${botOnSolana?.maxBuy} ${qSymbolFinished}
  Speed: ${botOnSolana?.delayTime} sec`
  );
}

// Function 7: Prepare transactions for volume making
async function prepareTransactions(botOnSolana: any, curbotOnSolana: any, isCPMM: boolean, mainBalance: number, sideBalance: number, subWallets: any, baseToken: Token, quoteToken: Token, poolInfo: any, sideBuy: boolean) {

  // Quote-token-aware decimals and USD price.
  // For SOL pools: quoteDecimals=9, quoteUsdPrice=SOL_PRICE. For USD1: 6, ~1.
  const usesUSD1 = isUSD1Quote(botOnSolana);
  const quoteDecimals = Number(botOnSolana?.quoteTokenDecimals) || 9;
  const quoteUnit = 10 ** quoteDecimals;
  const quoteUsdPrice = getQuoteUsdPrice(botOnSolana, SOL_PRICE);
  const quoteSymbol = botOnSolana?.quoteTokenSymbol || "SOL";

  // Calculate max buy amount (in raw quote-token units: lamports for SOL, 1e6 units for USD1).
  let maxBuyAmount = Number(botOnSolana.maxBuy) * quoteUnit;

  // Decode the main wallet early — we may need it both for the USD1 refill
  // check (below) and for the funding transaction (further down).
  const mainWallet = Keypair.fromSecretKey(bs58.decode(botOnSolana.mainWallet.privateKey));

  // Compare against the main wallet's quote-token balance (1/4 ceiling).
  // For SOL, use the SOL lamports balance passed in (mainBalance).
  // For USD1, fetch the main wallet's USD1 ATA balance since mainBalance is SOL.
  // If a USD1 refill is needed this iteration, we build the swap instructions
  // here and use the post-refill projected balance for sizing; the actual
  // swap instructions are prepended to `fundingIxs` below so they execute in
  // the same bundle.
  let availableQuote = mainBalance;
  let refillIxs: TransactionInstruction[] = [];
  if (usesUSD1) {
    try {
      availableQuote = await getMainWalletUsd1Balance(mainWallet.publicKey);
    } catch {
      availableQuote = 0;
    }

    if (!sideBuy) {
      const maxBuyRaw = Math.ceil(Number(botOnSolana.maxBuy || 0.01) * quoteUnit);
      const refillFloor = Math.ceil(maxBuyRaw * MAKER_BOT_MAX_PER_TX * USD1_REFILL_THRESHOLD_MULT);
      if (availableQuote < refillFloor) {
        const refillTarget = maxBuyRaw * MAKER_BOT_MAX_PER_TX * USD1_BOOTSTRAP_MULT;
        console.log(`[USD1] Balance ${availableQuote / 1e6} < floor ${refillFloor / 1e6}, refilling in-bundle → target ${refillTarget / 1e6}`);
        const refill = await buildRefillSolToUsd1Ixs(mainWallet, refillTarget);
        if (refill && refill.ixs.length > 0) {
          refillIxs = refill.ixs;
          // After the refill ix executes at the top of the funding tx, the
          // wallet will hold ~refillTarget USD1. Use that for sub-wallet sizing
          // so the iteration doesn't under-buy after a successful refill.
          availableQuote = refillTarget;
        } else if (refill && refill.ixs.length === 0) {
          // No refill was actually needed (race: balance topped up between
          // our read and the helper's read). Leave availableQuote as-is.
        } else {
          console.log("[USD1] In-bundle refill failed; proceeding with current USD1 balance.");
        }
      }
    }
  }
  if (maxBuyAmount >= Number(availableQuote / 4)) {
    maxBuyAmount = Number(availableQuote / 4);
    console.log(`Max Buy Amount is too high. Set to 1/4 of main ${quoteSymbol} balance: `, maxBuyAmount / quoteUnit, availableQuote / quoteUnit);
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

      // maxBuy * quoteUsdPrice = USD value of one buy; used to scale against lpSize (USD).
      let rate = lpSize / (quoteUsdPrice * Number(botOnSolana.maxBuy) * 4.5 * multiplier * 6);
      if (rate < 1)
        maxBuyAmount = maxBuyAmount * rate;

      console.log("Rate: ", rate, "lpSize: ", lpSize, `${quoteSymbol} Price:`, quoteUsdPrice);
    }
  }

  if (sideBuy) {
    // Small dust-sized side buy: 1-10 micro-units of the quote token.
    maxBuyAmount = randomInt(1, 10) * quoteUnit / 100000;
  }

  console.log(sideBuy ? "==> SIDE BUY" : "==> MAIN BUY");
  console.log(`===> Final Max Buy Amount : ${maxBuyAmount / quoteUnit} ${quoteSymbol}`);

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
    console.log(`Buy Quote Amount: ${randfactor * maxBuyAmount / quoteUnit} ${quoteSymbol}`);
    console.log(`${quoteSymbol} USD Price: ${quoteUsdPrice}`);
    if (curbotOnSolana && curbotOnSolana?.dexId == "pumpswap") {
      newMadeVolume += randfactor * maxBuyAmount / quoteUnit * quoteUsdPrice * 1.9;
    } else {
      newMadeVolume += randfactor * maxBuyAmount / quoteUnit * quoteUsdPrice * 1.8;
    }
    distSolArr.push(randfactor * maxBuyAmount);
    minOutArr.push(new BN(0));
  }

  console.log('✅✅✅Estimated New Made Volume for this bundle: ', newMadeVolume);

  const versionedTx = [];
  let sellCount = 0;
  const userBalance = await connection.getBalance(mainWallet.publicKey);
  console.log("User Wallet Address : ", mainWallet.publicKey.toBase58(), userBalance);

  // add funds to new fresh wallets. If we built a USD1 refill above, prepend
  // its swap ixs so the refill executes atomically with the funding transfers
  // at the head of the Jito bundle.
  const fundingIxs: TransactionInstruction[] = [...refillIxs];
  for (let i = 0; i < MAKER_BOT_MAX_PER_TX; i++) {
    fundingIxs.push(
      SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: subWallets[i].publicKey,
        lamports: 890880 + 10000,
      })
    );
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
  while (sellPositions.size < pattern.sellCount) {
    const position = Math.floor(Math.random() * (pattern.buyCount - 1));
    sellPositions.add(position);
  }
  // sellPositions.add(pattern.buyCount - 1);  // last position must sell token

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
      const makerMade = Number(updatedBot?.makerMade) + MAKER_BOT_MAX_PER_TX;
      const txDone = Number(updatedBot?.txDone) + MAKER_BOT_MAX_PER_TX + sellCount;

      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        volumeMade,
        makerMade,
        txDone,
        status: volumeMade >= botOnSolana?.targetVolume ? BOT_STATUS.ARCHIVED_TARGET_VOLUME : BOT_STATUS.RUNNING,
      });
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
