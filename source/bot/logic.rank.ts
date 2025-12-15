require("require-esm-as-empty-object");

import { Bot, session, InputFile } from "grammy";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from "@solana/web3.js";
import * as Web3 from '@solana/web3.js';
import { getMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Token } from "@raydium-io/raydium-sdk";
import bs58 from "bs58";
import BN from "bn.js";
import {
  getPoolInfo,
  createAndSendBundle,
  updateRecentBlockHash,
  getRandomNumber,
  formatTime,
  makeVersionedTransactionsWithMultiSign,
  toast,
  getTipInstruction,
  createAndSendBundleEx,
  createAndSendBundleExV2,
  createAndSendBundleExV3,
  checkBundleV3
} from "../utils/common";
import { sendBundlesRotating } from './bundle'

import VolumeBotModel from "../database/models/volumebot.model";
import { createTokenAccountTxPumpswap, makeBuySellTransactionPumpswapRank, makeBuySellTransactionPumpswapVolume } from "../dexs/pumpswap";

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
  makerBots,
} from "./const";
import { SystemProgram } from "@solana/web3.js";
import { sleep } from "../utils/common";
import * as path from 'path';
import { randomInt } from "crypto";
import { Connection } from "@solana/web3.js";
import { TransactionInstruction } from "@solana/web3.js";
import { createTokenAccountTxRaydium, makeBuySellTransactionRaydiumRank, makeBuySellTransactionRaydiumVolume, makeSellTransactionRaydium } from "../dexs/raydium";
import { addRaydiumSDK, alertToAdmins, bot, notifyToChannel } from ".";
import AmmImpl from "@meteora-ag/dynamic-amm-sdk";
import DLMM from '@meteora-ag/dlmm-sdk-public';
import { createTokenAccountTxMeteora, initMeteoraBuy, makeBuySellTransactionMeteoraRank } from "../dexs/meteora";
import { makeBuySellTransactionPumpFunBump } from "../dexs/pumpfun";
import * as database from "../database/db";
import { getReferralTaxInstruction } from "../utils/common";

const MAIN_WALLET_KEY = process.env.MAIN_WALLET_KEY
  ? process.env.MAIN_WALLET_KEY
  : "";
const MAIN_WALLET = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_KEY));

export async function makerMaker() {
  try {
    //find all bots that has start true value in startStopFlag
    const startedBots = await VolumeBotModel.find({ $and: [{ enable: true }, { 'boostType.makerBoost': true }] })
      .populate("mainWallet token")
      .lean();

    if (!startedBots || startedBots.length == 0) {
      return;
    }

    console.log("makerBots.length", startedBots.length);
    for (let index = 0; index < startedBots.length; index++) {
      const botOnSolana: any = startedBots[index];

      if (botOnSolana == null) {
        continue;
      }

      if (makerBots.get(botOnSolana._id)) continue;

      makerBots.set(botOnSolana._id, true);

      if (botOnSolana?.dexId == "raydium") {
        raydiumMakerFunc(botOnSolana);
      } else if (botOnSolana?.dexId == "pumpswap") {
        pumpswapMakerFunc(botOnSolana);
      } else if (botOnSolana?.dexId == "pumpfun") {
        pumpfunMakerFunc(botOnSolana);
      } else if (botOnSolana?.dexId == "meteora") {
        meteoraMakerFunc(botOnSolana);
      }

      makerBots.delete(botOnSolana._id);
    }
  } catch (err) {
    console.error(err);
  }
}

// Common utility function for maker bot operations
async function commonMakerBotLogic(
  curbotOnSolana: any,
  setupFunction: (curbotOnSolana: any, token: Token) => Promise<any>,
  transactionFunction: (
    connection: any,
    wallet: any,
    mainWallet: any,
    distSol: any,
    index: number,
    organicMode: boolean,
    lookupTable: string,
    additionalParams?: any
  ) => Promise<{ volTx: any; isSell: boolean }>
) {
  if (makerBots.get(curbotOnSolana._id.toString())) return;
  makerBots.set(curbotOnSolana._id.toString(), true);

  console.log(">>>>>>> @ current Token : ", curbotOnSolana?.token?.address);
  let running = true;
  let initialBundleFailedCount = 0;

  const token = curbotOnSolana?.token.address;
  const baseToken = new Token(
    curbotOnSolana.token?.is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    token,
    curbotOnSolana.token.decimals
  );

  // Setup specific to each DEX (Raydium or PumpSwap)
  const setupResult = await setupFunction(curbotOnSolana, baseToken);

  if (!setupResult.success) {
    console.log(`[Rank] Can't get pool info of tokens ${curbotOnSolana.token.address}`);
    makerBots.delete(curbotOnSolana._id.toString());
    return;
  }

  let txDone = curbotOnSolana.txDone;
  let makerMade = curbotOnSolana.makerMade;
  let targetMaker = curbotOnSolana.targetMaker;

  while (running) {
    const botOnSolana: any = await VolumeBotModel.findOne({ _id: curbotOnSolana._id })
      .populate("mainWallet token")
      .lean();

    if (!botOnSolana || botOnSolana.enable == false) {
      console.log("[Rank] Bot disabled or not found. Stopping...");
      break;
    }

    if (initialBundleFailedCount > MAX_BUNDLE_FAILED_COUNT) {
      console.log("### Initial bundle failed count is over the limit! Restart loop...");
      break;
    }

    let workedSeconds = botOnSolana.workedSeconds || 0;
    let newSpentSeconds = 0;
    let usedWallet = botOnSolana.usedWallet || 0;
    let mainWallet = Keypair.fromSecretKey(bs58.decode(curbotOnSolana.mainWallet.privateKey));

    await addRaydiumSDK(mainWallet.publicKey);

    try {
      const startTime = Date.now();
      let subWallets: Keypair[] = [];

      console.log("makerMade", makerMade, "targetMaker", targetMaker, "stop condition: ", makerMade >= targetMaker);
      if (makerMade >= targetMaker) {
        await handleBotCompletion(botOnSolana);
        break;
      }

      // Handle lookup table creation if needed
      if (!botOnSolana.addressLookupTable) {
        // console.log("is2022: ", curbotOnSolana.token?.is2022);
        const lookupTableAddress = await setupResult.createLookupTable(connection, mainWallet, baseToken);

        if (lookupTableAddress) {
          await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
            addressLookupTable: lookupTableAddress,
          });
          botOnSolana.addressLookupTable = lookupTableAddress;
        }
      }

      if (botOnSolana.dexId == "raydium" && !botOnSolana.addressLookupTable) {
        console.log("[Rank] Address lookup table not found. Break!");
        break;
      }

      const organicMode = botOnSolana.organicMode;

      // Check main wallet balance before proceeding
      const mainWalletBalance = await connection.getBalance(mainWallet.publicKey);
      const requiredLamportsPerWallet = 890880 + 10000; // Account creation + buffer
      const totalRequiredLamports = requiredLamportsPerWallet * MAKER_BOT_MAX_PER_TX + (MIN_REMAIN_SOL * LAMPORTS_PER_SOL);
      
      console.log(`[Rank] Main wallet balance: ${(mainWalletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      console.log(`[Rank] Required balance: ${(totalRequiredLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      
      if (mainWalletBalance < totalRequiredLamports) {
        console.log(`[Rank] Insufficient balance! Required: ${(totalRequiredLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL, Available: ${(mainWalletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        try {
          await bot.api.sendMessage(
            botOnSolana.userId,
            `⚠️ <b>Rank Bot Paused</b>\n\nInsufficient balance in main wallet.\n\n<b>Required:</b> ${(totalRequiredLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL\n<b>Available:</b> ${(mainWalletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n\nPlease add more SOL to continue.`,
            { parse_mode: "HTML" }
          );
        } catch (err) {
          console.error("[Rank] Error sending insufficient balance notification:", err);
        }
        break;
      }

      // generate sub wallets and build funding transactions
      const fundingIxs: TransactionInstruction[] = [];
      for (let i = 0; i < MAKER_BOT_MAX_PER_TX; i++) {
        const payerKeypair = Keypair.generate();
        subWallets.push(payerKeypair);

        fundingIxs.push(
          SystemProgram.transfer({
            fromPubkey: mainWallet.publicKey,
            toPubkey: payerKeypair.publicKey,
            lamports: requiredLamportsPerWallet,
          })
        );
      }

      // add referral tax instruction to the fundingIxs
      const user: any = await database.selectUser({ chatid: botOnSolana.userId });
      const referral = user?.referredBy;

      if (referral) {
        const referralUser: any = await database.selectUser({ chatid: referral });
        if (referralUser?.depositWallet) {
          const referralWallet = Keypair.fromSecretKey(bs58.decode(referralUser.depositWallet));

          const referralTaxInstruction = getReferralTaxInstruction(referralWallet.publicKey, mainWallet);
          fundingIxs.push(...referralTaxInstruction);
        }
      }

      const fundingTx = await makeVersionedTransactionsWithMultiSign(connection, [mainWallet], fundingIxs);

      let distSolArr = [];
      const signers: any = [[mainWallet]];

      for (let i = 0; i < subWallets.length; i++) {
        distSolArr.push(new BN(100));
      }

      const versionedTx: VersionedTransaction[] = [fundingTx];
      let sellCount = 0;

      // Create an array of promises for processing all wallets
      const walletProcessingPromises = subWallets.map(async (wallet, i) => {
        try {
          const { volTx, isSell } = await transactionFunction(
            connection,
            wallet,
            mainWallet,
            distSolArr[i],
            i,
            organicMode,
            botOnSolana.addressLookupTable,
            setupResult.additionalParams
          );

          return {
            success: true,
            volTx,
            isSell,
            wallet
          };
        } catch (err) {
          console.log(`[Rank] Error processing wallet ${i}:`, err);
          return {
            success: false,
            wallet
          };
        }
      });

      // Process all wallet transactions in parallel
      const results = await Promise.all(walletProcessingPromises);

      // Process the results
      let successfulTxCount = 0;
      results.forEach(result => {
        if (!result.success) {
          if (txDone === 0) initialBundleFailedCount++;
          return;
        }

        if (result.isSell) {
          sellCount++;
        }

        if (result.volTx) {
          versionedTx.push(result.volTx);
          signers.push([result.wallet, mainWallet]);
          successfulTxCount++;
        } else if (txDone === 0) {
          initialBundleFailedCount++;
        }
      });

      if (successfulTxCount < 1) {
        console.log("[Rank] No successful transactions created. Waiting before retry...");
        await new Promise(resolve => setTimeout(resolve, 10000));
        continue;
      }

      console.log(`[Rank] Created ${successfulTxCount} successful transactions out of ${MAKER_BOT_MAX_PER_TX}`);
      console.log(`[Rank] Sell count: ${sellCount}`);

      const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      for (let i = 0; i < versionedTx.length; i++) {
        if (versionedTx[i]) {
          versionedTx[i].message.recentBlockhash = recentBlockhash;
          versionedTx[i].sign(signers[i]);
        }
      }

      // // send each versioned transaction
      // for (let i = 0; i < versionedTx.length; i++) {
      //   if (versionedTx[i]) {
      //     try {
      //       const txid = await connection.sendTransaction(versionedTx[i], {
      //         maxRetries: 3,
      //         skipPreflight: false,
      //         preflightCommitment: "confirmed",
      //       });
      //       console.log("Transaction sent successfully: ", txid);

      //       const ret = await connection.confirmTransaction(
      //         txid,
      //         "confirmed"
      //       );
      //       console.log("Transaction confirmed: ", ret);
      //     } catch (err) {
      //       console.error("Error sending transaction: ", err);
      //     }
      //   }
      // }

      createAndSendBundleEx(
        connection,
        mainWallet,
        versionedTx
      ).then(async (bundleUUID) => {
        if (bundleUUID != null) {
          checkBundleV3(bundleUUID).then(async (ret) => {
            console.log("[Rank] bundle uuid: ", bundleUUID, "| Result: ", ret);
            if (ret) {
              txDone += successfulTxCount + sellCount;
              makerMade += successfulTxCount;

              // Update database immediately on success
              await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
                txDone: txDone,
                makerMade: makerMade,
              });
            } else {
              if (txDone === 0) initialBundleFailedCount++;
              console.log("[Rank] Bundle failed");
            }
          }).catch((err) => {
            console.log("[Rank] Error on checking bundle: ", err);
          });
        } else {
          console.log("[Rank] Bundle UUID is null");
        }
      }).catch((err) => {
        console.log("[Rank] Error creating/sending bundle: ", err);
      });

      newSpentSeconds = (Date.now() - startTime) / 1000;
      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        workedSeconds: Number(workedSeconds) + Number(newSpentSeconds),
        usedWallet: (usedWallet + successfulTxCount) % MAX_WALLET_COUNT,
      });

      // await new Promise(resolve => setTimeout(resolve, 30000));

      // Delay between batches if near completion
      if (txDone + 30 >= botOnSolana.targetMaker) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (err) {
      console.error(err);
    }
  }

  makerBots.delete(curbotOnSolana._id.toString());
}

// Common utility function for bump bot operations
async function BumpBotLogic(
  curbotOnSolana: any,
  setupFunction: (curbotOnSolana: any, token: Token) => Promise<any>,
  transactionFunction: (
    connection: any,
    wallet: any,
    mainWallet: any,
    distSol: any,
    index: number,
    lookupTable: string,
    additionalParams?: any
  ) => Promise<{ bumpTx: any }>
) {
  if (makerBots.get(curbotOnSolana._id.toString())) return;
  makerBots.set(curbotOnSolana._id.toString(), true);

  console.log(">>>>>>> @ current Token : ", curbotOnSolana?.token?.address);
  let running = true;
  let initialBundleFailedCount = 0;

  const token = curbotOnSolana?.token.address;
  const baseToken = new Token(
    curbotOnSolana.token?.is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    token,
    curbotOnSolana.token.decimals
  );

  // Setup specific to each DEX
  const setupResult = await setupFunction(curbotOnSolana, baseToken);

  if (!setupResult.success) {
    console.log(`[Bump] Can't get pool info of tokens ${curbotOnSolana.token.address}`);
    makerBots.delete(curbotOnSolana._id.toString());
    return;
  }

  let txDone = curbotOnSolana.txDone;
  let makerMade = curbotOnSolana.makerMade;
  let targetMaker = curbotOnSolana.targetMaker;

  while (running) {
    const botOnSolana: any = await VolumeBotModel.findOne({ userId: curbotOnSolana.userId })
      .populate("mainWallet token")
      .lean();

    if (botOnSolana.enable == false) {
      break;
    }

    if (initialBundleFailedCount > MAX_BUNDLE_FAILED_COUNT) {
      console.log("### Initial bundle failed count is over the limit! Restart loop...");
      break;
    }

    let workedSeconds = botOnSolana.workedSeconds || 0;
    let newSpentSeconds = 0;
    // let usedWallet = botOnSolana.usedWallet || 0;
    let mainWallet = Keypair.fromSecretKey(bs58.decode(curbotOnSolana.mainWallet.privateKey));

    // await addRaydiumSDK(mainWallet.publicKey);

    try {
      const startTime = Date.now();
      let subWallets: Keypair[] = [];

      console.log("makerMade", makerMade, "targetMaker", targetMaker, "stop condition: ", makerMade >= targetMaker);
      // if (makerMade >= targetMaker) {
      //   await handleBotCompletion(botOnSolana);
      //   break;
      // }

      // Handle lookup table creation if needed
      // if ((botOnSolana.addressLookupTable == "" || botOnSolana.addressLookupTable == null || botOnSolana.addressLookupTable == undefined)) {
      //   // console.log("is2022: ", curbotOnSolana.token?.is2022);
      //   const lookupTableAddress = await setupResult.createLookupTable(connection, mainWallet, baseToken);

      //   if (lookupTableAddress !== "" && lookupTableAddress !== null && lookupTableAddress !== undefined) {
      //     await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
      //       addressLookupTable: lookupTableAddress,
      //     });
      //     botOnSolana.addressLookupTable = lookupTableAddress;
      //   }
      // }

      // if (botOnSolana.dexId == "raydium" && (botOnSolana.addressLookupTable == "" || botOnSolana.addressLookupTable == null || botOnSolana.addressLookupTable == undefined)) {
      //   console.log("[Bump] Address lookup table not found. Break!");
      //   break;
      // }

      subWallets.push(mainWallet);

      const versionedTx: VersionedTransaction[] = [];
      const signers: any = [];

      // add referral tax instruction
      const user: any = await database.selectUser({ chatid: botOnSolana.userId });
      const referral = user?.referredBy;

      if (referral) {
        const referralUser: any = await database.selectUser({ chatid: referral });
        const referralWallet = Keypair.fromSecretKey(bs58.decode(referralUser.depositWallet));

        const referralTaxInstruction = getReferralTaxInstruction(referralWallet.publicKey, mainWallet);
        const fundingTx = await makeVersionedTransactionsWithMultiSign(connection, [mainWallet], [...referralTaxInstruction]);
        versionedTx.push(fundingTx);
        signers.push([mainWallet]);
      }

      let buySolAmount = new BN(0.011 * LAMPORTS_PER_SOL);

      // Create an array of promises for processing all wallets
      const walletProcessingPromises = subWallets.map(async (wallet, i) => {
        try {
          const { bumpTx } = await transactionFunction(
            connection,
            wallet,
            mainWallet,
            buySolAmount,
            i,
            botOnSolana.addressLookupTable,
            setupResult.additionalParams
          );

          return {
            success: true,
            bumpTx,
            wallet
          };
        } catch (err) {
          console.log(err);
          return {
            success: false
          };
        }
      });

      // Process all wallet transactions in parallel
      const results = await Promise.all(walletProcessingPromises);

      // Process the results
      results.forEach(result => {
        if (!result.success) {
          if (txDone === 0) initialBundleFailedCount++;
          return;
        }

        if (result.bumpTx) {
          versionedTx.push(result.bumpTx);
          signers.push([result.wallet]);
        } else if (txDone === 0) {
          initialBundleFailedCount++;
        }
      });

      const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      for (let i = 0; i < versionedTx.length; i++) {
        if (versionedTx[i]) {
          versionedTx[i].message.recentBlockhash = recentBlockhash;
          versionedTx[i].sign(signers[i]);
        }
      }

      // // send each versioned transaction
      // for (let i = 0; i < versionedTx.length; i++) {
      //   if (versionedTx[i]) {
      //     try {
      //       const txid = await connection.sendTransaction(versionedTx[i], {
      //         maxRetries: 3,
      //         skipPreflight: false,
      //         preflightCommitment: "confirmed",
      //       });
      //       console.log("Transaction sent successfully: ", txid);

      //       const ret = await connection.confirmTransaction(
      //         txid,
      //         "confirmed"
      //       );
      //       console.log("Transaction confirmed: ", ret);
      //     } catch (err) {
      //       console.error("Error sending transaction: ", err);
      //     }
      //   }
      // }

      // const bundleUUID = await createAndSendBundleExV3(
      //   connection,
      //   mainWallet,
      //   versionedTx
      // );

      const ret = await sendBundlesRotating([versionedTx]);

      if (ret) {
        txDone += 2;
        makerMade += 2;
      } else {
        if (txDone === 0) initialBundleFailedCount++;
      }

      // if (bundleUUID != null) {
      //   checkBundleV3(bundleUUID).then(async (ret) => {
      //     console.log("[Rank] bundle uuid: ", bundleUUID, "| Result: ", ret);

      //     if (ret) {
      //       txDone += 2;
      //       makerMade += 2;

      //     } else {
      //       if (txDone === 0) initialBundleFailedCount++;
      //     }
      //   }).catch((err) => {
      //     console.log("Error on checking bundle: ", err);
      //   });
      // }


      newSpentSeconds = (Date.now() - startTime) / 1000;
      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        workedSeconds: Number(workedSeconds) + Number(newSpentSeconds),
        txDone,
        // makerMade,
      });

      // // Delay between batches if near completion
      // if (txDone + 30 >= botOnSolana.targetMaker) {
      //   await new Promise(resolve => setTimeout(resolve, 2000));
      // }

      await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (err) {
      console.error(err);
    }
  }

  makerBots.delete(curbotOnSolana._id.toString());
}

// Raydium-specific setup function
async function raydiumSetup(curbotOnSolana: any, baseToken: Token) {
  if (!curbotOnSolana.pairAddress || !curbotOnSolana.poolType || !curbotOnSolana.dexId) {
    return { success: false };
  }

  const mainWallet = Keypair.fromSecretKey(bs58.decode(curbotOnSolana.mainWallet.privateKey));

  let raydium = await addRaydiumSDK(mainWallet.publicKey);

  const poolInfo = await getPoolInfo(
    connection2,
    quoteToken,
    baseToken,
    raydium,
    curbotOnSolana.poolType.toLowerCase(),
  );

  if (!poolInfo) {
    console.log("[Rank] Can't get pool info of tokens ", baseToken.mint.toString());
    return { success: false };
  }

  return {
    success: true,
    additionalParams: {
      poolInfo,
      quoteToken,
      baseToken
    },
    createLookupTable: async (connection: any, mainWallet: any, baseToken: any) => {
      return createTokenAccountTxRaydium(
        connection,
        mainWallet,
        baseToken.mint,
        poolInfo,
        raydiumSDKList.get(mainWallet.publicKey.toString()),
        curbotOnSolana.token?.is2022
      );
    }
  };
}

// PumpSwap-specific setup function
async function pumpswapSetup(curbotOnSolana: any, baseToken: Token) {
  if (!curbotOnSolana.pairAddress || !curbotOnSolana.poolType || !curbotOnSolana.dexId) {
    return { success: false };
  }

  return {
    success: true,
    additionalParams: {
      pairAddress: new PublicKey(curbotOnSolana.pairAddress)
    },
    createLookupTable: async (connection: any, mainWallet: any, baseToken: any) => {
      return createTokenAccountTxPumpswap(
        connection,
        mainWallet,
        baseToken.mint
      );
    }
  };
}

// Pumpfun-specific setup function
async function pumpfunSetup(curbotOnSolana: any, baseToken: Token) {
  if (!curbotOnSolana.pairAddress || !curbotOnSolana.poolType || !curbotOnSolana.dexId) {
    return { success: false };
  }

  return {
    success: true,
    additionalParams: {
      tokenAddress: new PublicKey(curbotOnSolana.token.address),
    },
    createLookupTable: async (connection: any, mainWallet: any, baseToken: any) => {
      return createTokenAccountTxPumpswap(
        connection,
        mainWallet,
        baseToken.mint
      );
    }
  };
}

// Meteora-specific setup function
async function meteoraSetup(curbotOnSolana: any, baseToken: Token) {
  if (!curbotOnSolana.pairAddress || !curbotOnSolana.poolType || !curbotOnSolana.dexId) {
    return { success: false };
  }

  let pool = null;
  if (curbotOnSolana.poolType == "DYN") {
    pool = await AmmImpl.create(connection, new PublicKey(curbotOnSolana.pairAddress));
  } else if (curbotOnSolana.poolType == "DLMM") {
    pool = await DLMM.create(connection, new PublicKey(curbotOnSolana.pairAddress), { cluster: "mainnet-beta" });
  }

  if (pool) {
    await initMeteoraBuy(connection, pool, curbotOnSolana.poolType, Keypair.fromSecretKey(bs58.decode(curbotOnSolana.mainWallet.privateKey)));
  }

  return {
    success: true,
    additionalParams: {
      pool: pool,
      poolType: curbotOnSolana.poolType,
    },
    createLookupTable: async (connection: any, mainWallet: any, baseToken: any) => {
      return createTokenAccountTxMeteora(
        connection,
        mainWallet,
        baseToken.mint
      );
    }
  };
}

// Raydium maker function using the common logic
export async function raydiumMakerFunc(curbotOnSolana: any) {
  await commonMakerBotLogic(
    curbotOnSolana,
    raydiumSetup,
    async (connection, wallet, mainWallet, distSol, index, organicMode, lookupTable, additionalParams) => {
      const { poolInfo, quoteToken, baseToken } = additionalParams;
      return await makeBuySellTransactionRaydiumRank(
        connection,
        wallet,
        mainWallet,
        distSol,
        quoteToken,
        baseToken,
        curbotOnSolana.token.decimals,
        poolInfo,
        raydiumSDKList.get(mainWallet.publicKey.toString()),
        index,
        index == 0,
        organicMode,
        lookupTable
      );
    }
  );
}

// PumpSwap maker function using the common logic
export async function pumpswapMakerFunc(curbotOnSolana: any) {
  await commonMakerBotLogic(
    curbotOnSolana,
    pumpswapSetup,
    async (connection, wallet, mainWallet, distSol, index, organicMode, lookupTable, additionalParams) => {
      const { pairAddress } = additionalParams;
      return await makeBuySellTransactionPumpswapRank(
        connection,
        pairAddress,
        wallet,
        mainWallet,
        distSol,
        index,
        organicMode,
        lookupTable
      );
    }
  );
}

// Pumpfun maker function using the common logic
export async function pumpfunMakerFunc(curbotOnSolana: any) {
  await BumpBotLogic(
    curbotOnSolana,
    pumpfunSetup,
    async (connection, wallet, mainWallet, distSol, index, lookupTable, additionalParams) => {
      const { tokenAddress } = additionalParams;
      return await makeBuySellTransactionPumpFunBump(
        connection,
        new PublicKey(tokenAddress),
        wallet,
        mainWallet,
        distSol,
        curbotOnSolana.token?.is2022
      );
    }
  );
}

// Meteora maker function using the common logic
export async function meteoraMakerFunc(curbotOnSolana: any) {
  await commonMakerBotLogic(
    curbotOnSolana,
    meteoraSetup,
    async (connection, wallet, mainWallet, distSol, index, organicMode, lookupTable, additionalParams) => {
      const { pool, poolType } = additionalParams;
      return await makeBuySellTransactionMeteoraRank(
        connection,
        pool,
        poolType,
        wallet,
        mainWallet,
        distSol,
        index,
        organicMode,
        lookupTable
      );
    }
  );
}

// Helper function to handle bot completion
async function handleBotCompletion(botOnSolana: any) {
  await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
    startStopFlag: 0,
    status: BOT_STATUS.ARCHIVED_TARGET,
    enable: false,
    isPending: true
  });

  const mainWallet = Keypair.fromSecretKey(bs58.decode(botOnSolana.mainWallet.privateKey));
  const mainBalance = await connection.getBalance(mainWallet.publicKey);
  const usedSolAmount = (Number(botOnSolana.startSolAmount - mainBalance) / 10 ** 9);

  // Enable next pending user
  const pendingUser = await VolumeBotModel.findOne({
    enable: true,
    isPending: true,
    'boostType.makerBoost': true,
  });

  if (pendingUser) {
    await VolumeBotModel.findByIdAndUpdate(pendingUser._id, {
      isPending: false
    });
  }

  // Send completion notifications
  const logoPath = path.join(__dirname, '../assets/logo.jpg');
  try {
    await bot.api.sendPhoto(botOnSolana.userId, new InputFile(logoPath), {
      caption: `🔥 ${process.env.BOT_TITLE} is done!`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ Close', callback_data: 'close' }],
          // [{ text: '📢 DM Campaign to Investors', url: 'https://t.me/bLackrockfather' }]
        ]
      }
    });
  } catch (error) {
    console.error("Failed to send completion message to user:", error);
  }

  let user_name = (await bot.api.getChat(botOnSolana.userId))?.username;

  // // Notify admins
  // for (const adminId of ADMIN_USERS) {
  //   try {
  //     await bot.api.sendMessage(adminId, 
  //       `Finished 🏁\n
  // Chart: <a href="https://dexscreener.com/solana/${botOnSolana?.token?.address}">${botOnSolana?.token?.name}</a>
  // Client: @${user_name} (<code>${botOnSolana?.userId}</code>) 
  // Plan: ${botOnSolana?.depositAmount} SOL for ${botOnSolana?.targetMaker} makers
  // Used: ${usedSolAmount?.toFixed(9)} SOL
  // Worked: ${formatTime(botOnSolana?.workedSeconds)}`,
  //       { parse_mode: "HTML" }
  //     );
  //   } catch (error) {
  //     console.error(`Failed to send message to admin ${adminId}:`, error);
  //   }
  // }

  // notify to channel
  notifyToChannel(
    `Finished 🏁\n
    Chart: <a href="https://dexscreener.com/solana/${botOnSolana?.token?.address}">${botOnSolana?.token?.name}</a>
    Client: @${user_name} (<code>${botOnSolana?.userId}</code>) 
    Plan: ${botOnSolana?.targetMaker} makers
    Used: ${usedSolAmount?.toFixed(9)} SOL`
  );
}
