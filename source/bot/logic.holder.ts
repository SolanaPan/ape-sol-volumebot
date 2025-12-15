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
  checkBundleV3,
  getReferralTaxInstruction
} from "../utils/common";

import VolumeBotModel from "../database/models/volumebot.model";
import { createTokenAccountTxPumpswap, makeBuySellTransactionPumpswapHolder, makeBuySellTransactionPumpswapRank, makeBuySellTransactionPumpswapVolume } from "../dexs/pumpswap";

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
  holderBots,
} from "./const";
import { SystemProgram } from "@solana/web3.js";
import { sleep } from "../utils/common";
import * as path from 'path';
import { randomInt } from "crypto";
import { Connection } from "@solana/web3.js";
import { TransactionInstruction } from "@solana/web3.js";
import { createTokenAccountTxRaydium, makeBuySellTransactionRaydiumRank, makeBuySellTransactionRaydiumVolume, makeBuyTransactionRaydiumHolder, makeSellTransactionRaydium } from "../dexs/raydium";
import { addRaydiumSDK, alertToAdmins, bot, notifyToChannel } from ".";
import AmmImpl from "@meteora-ag/dynamic-amm-sdk";
import DLMM from '@meteora-ag/dlmm-sdk-public';
import { createTokenAccountTxMeteora, makeBuySellTransactionMeteoraHolder, makeBuySellTransactionMeteoraRank } from "../dexs/meteora";
import { createTokenAccountTxPumpFun, makeBuySellTransactionPumpFunHolder, makeBuySellTransactionPumpFunBump } from "../dexs/pumpfun";
import zombieModel from "../database/models/zombie.model";
import * as database from "../database/db";

const MAIN_WALLET_KEY = process.env.MAIN_WALLET_KEY
  ? process.env.MAIN_WALLET_KEY
  : "";
const MAIN_WALLET = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_KEY));

export async function holderMaker() {
  try {
    //find all bots that has start true value in startStopFlag
    const startedBots = await VolumeBotModel.find({ $and: [{ enable: true }, { 'boostType.holderBoost': true }] })
      .populate("mainWallet token")
      .lean();

    if (!startedBots || startedBots.length == 0) {
      return;
    }

    console.log("holderBots.length", startedBots.length);
    for (let index = 0; index < startedBots.length; index++) {
      const botOnSolana: any = startedBots[index];

      if (botOnSolana == null) {
        continue;
      }

      if (holderBots.get(botOnSolana._id)) continue;

      holderBots.set(botOnSolana._id, true);

      if (botOnSolana?.dexId == "raydium") {
        raydiumHolderMakerFunc(botOnSolana);
      } else if (botOnSolana?.dexId == "pumpswap") {
        pumpswapHolderMakerFunc(botOnSolana);
      } else if (botOnSolana?.dexId == "pumpfun") {
        pumpfunHolderMakerFunc(botOnSolana);
      } else if (botOnSolana?.dexId == "meteora") {
        meteoraHolderMakerFunc(botOnSolana);
      }

      holderBots.delete(botOnSolana._id);
    }
  } catch (err) {
    console.error(err);
  }
}

// Common utility function for maker bot operations
async function commonHolderMakerLogic(
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
  ) => Promise<{ volTx: any; isSell: boolean }>
) {
  if (holderBots.get(curbotOnSolana._id.toString())) return;
  holderBots.set(curbotOnSolana._id.toString(), true);

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
    console.log(`[Holder] Can't get pool info of tokens ${curbotOnSolana.token.address}`);
    holderBots.delete(curbotOnSolana._id.toString());
    return;
  }

  let holderMade = curbotOnSolana.holderMade;
  let makerMade = curbotOnSolana.makerMade;
  let txDone = curbotOnSolana.txDone;
  let targetHolder = curbotOnSolana.targetHolder;

  while (running) {
    const botOnSolana: any = await VolumeBotModel.findOne({ userId: curbotOnSolana.userId })
      .populate("mainWallet token")
      .lean();

    if (!botOnSolana || botOnSolana.enable == false) {
      console.log("⚠ [Holder] Bot disabled or not found. Stopping...");
      break;
    }

    if (initialBundleFailedCount > MAX_BUNDLE_FAILED_COUNT) {
      console.log("### Initial bundle failed count is over the limit! Restart loop...");
      break;
    }

    let workedSeconds = botOnSolana.workedSeconds || 0;
    let newSpentSeconds = 0;
    let mainWallet = Keypair.fromSecretKey(bs58.decode(curbotOnSolana.mainWallet.privateKey));

    await addRaydiumSDK(mainWallet.publicKey);

    try {
      const startTime = Date.now();
      let subWallets: Keypair[] = [];

      console.log("holderMade", holderMade, "targetHolder", targetHolder, "stop condition: ", holderMade >= targetHolder);
      if (holderMade >= targetHolder) {
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
        console.log("[Holder] Address lookup table not found. Break!");
        break;
      }

      // Check main wallet balance before proceeding
      const mainWalletBalance = await connection.getBalance(mainWallet.publicKey);
      const requiredLamportsPerWallet = 890880 + 10000 + 6221970; // Account creation + buffer + token account
      const totalRequiredLamports = requiredLamportsPerWallet * MAKER_BOT_MAX_PER_TX + (MIN_REMAIN_SOL * LAMPORTS_PER_SOL);
      
      console.log(`[Holder] Main wallet balance: ${(mainWalletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      console.log(`[Holder] Required balance: ${(totalRequiredLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      
      if (mainWalletBalance < totalRequiredLamports) {
        console.log(`❗ [Holder] Insufficient balance! Required: ${(totalRequiredLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL, Available: ${(mainWalletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        try {
          await bot.api.sendMessage(
            botOnSolana.userId,
            `⚠️ <b>Holder Bot Paused</b>\n\nInsufficient balance in main wallet.\n\n<b>Required:</b> ${(totalRequiredLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL\n<b>Available:</b> ${(mainWalletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n\nPlease add more SOL to continue.`,
            { parse_mode: "HTML" }
          );
        } catch (err) {
          console.error("[Holder] Error sending insufficient balance notification:", err);
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

        // store the new wallet in the database
        await zombieModel.create({
          publickey: payerKeypair.publicKey.toBase58(),
          privatekey: bs58.encode(payerKeypair.secretKey),
          type: "holder"
        });
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
        distSolArr.push(new BN(0.0000001 * LAMPORTS_PER_SOL));
      }

      const versionedTx: VersionedTransaction[] = [fundingTx];

      // Create an array of promises for processing all wallets
      const walletProcessingPromises = subWallets.map(async (wallet, i) => {
        try {
          const { volTx, isSell } = await transactionFunction(
            connection,
            wallet,
            mainWallet,
            distSolArr[i],
            i,
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
          console.log(`[Holder] Error processing wallet ${i}:`, err);
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
          if (holderMade === 0) initialBundleFailedCount++;
          return;
        }

        if (result.volTx) {
          versionedTx.push(result.volTx);
          signers.push([result.wallet]);
          successfulTxCount++;
        } else if (holderMade === 0) {
          initialBundleFailedCount++;
        }
      });

      if (successfulTxCount < 1) {
        console.log("[Holder] No successful transactions created. Waiting before retry...");
        await new Promise(resolve => setTimeout(resolve, 10000));
        continue;
      }

      console.log(`[Holder] Created ${successfulTxCount} successful transactions out of ${MAKER_BOT_MAX_PER_TX}`);

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
            console.log("[Holder] bundle uuid: ", bundleUUID, "| Result: ", ret);
            if (ret) {
              holderMade += successfulTxCount;
              makerMade += successfulTxCount;
              txDone += successfulTxCount;

              // Update database immediately
              await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
                txDone: txDone,
                holderMade: holderMade,
                makerMade: makerMade,
              });

              // check balance of each sub wallet and send back to main wallet
              await sleep(12000);
              await refundRestSols(connection2, mainWallet, subWallets);
            } else {
              if (holderMade === 0) initialBundleFailedCount++;
              console.log("[Holder] Bundle failed, attempting refund...");
              // Try to refund anyway in case some transactions went through
              await sleep(12000);
              await refundRestSols(connection2, mainWallet, subWallets);
            }
          }).catch(async (err) => {
            console.log("[Holder] Error on checking bundle: ", err);
            // Try to refund in case of error
            await sleep(12000);
            await refundRestSols(connection2, mainWallet, subWallets);
          });
        } else {
          console.log("[Holder] Bundle UUID is null, attempting refund...");
          // Try to refund if bundle wasn't sent
          await sleep(12000);
          await refundRestSols(connection2, mainWallet, subWallets);
        }
      }).catch(async (err) => {
        console.log("[Holder] Error creating/sending bundle: ", err);
        // Try to refund in case of error
        await sleep(12000);
        await refundRestSols(connection2, mainWallet, subWallets);
      });

      newSpentSeconds = (Date.now() - startTime) / 1000;
      await VolumeBotModel.findByIdAndUpdate(botOnSolana._id, {
        workedSeconds: Number(workedSeconds) + Number(newSpentSeconds),
      });

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Delay between batches if near completion
      if (holderMade + 30 >= botOnSolana.targetHolder) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (err) {
      console.error(err);
    }
  }

  holderBots.delete(curbotOnSolana._id.toString());
}

async function refundRestSols(
  connection: Connection,
  mainWallet: Keypair,
  subWallets: Keypair[]
) {
  try {
    let transferIxs: TransactionInstruction[] = [];
    const MIN_REFUND_AMOUNT = 5000; // Minimum lamports worth refunding (to avoid tx fees being more than refund)
    
    for (let i = 0; i < subWallets.length; i++) {
      try {
        const balance = await connection.getBalance(subWallets[i].publicKey);
        console.log(`[Holder] Sub wallet ${i} (${subWallets[i].publicKey.toBase58()}) balance: ${balance} lamports (${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
        
        if (balance > MIN_REFUND_AMOUNT) {
          transferIxs.push(
            SystemProgram.transfer({
              fromPubkey: subWallets[i].publicKey,
              toPubkey: mainWallet.publicKey,
              lamports: balance,
            })
          );
        }
      } catch (err) {
        console.error(`[Holder] Error checking balance for sub wallet ${i}:`, err);
      }
    }
    
    if (transferIxs.length === 0) {
      console.log("[Holder] No funds to refund from sub wallets");
      return;
    }
    
    console.log(`[Holder] Attempting to refund from ${transferIxs.length} sub wallets`);
    
    const transferTx = await makeVersionedTransactionsWithMultiSign(connection, [...subWallets, mainWallet], transferIxs);
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transferTx.message.recentBlockhash = recentBlockhash;
    transferTx.sign([...subWallets, mainWallet]);
    
    let txid = await connection.sendTransaction(transferTx, {
      maxRetries: 5,
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    const ret = await connection.confirmTransaction(
      txid,
      "confirmed"
    );
    console.log("[Holder] Refund transaction confirmed: ", txid, "| Success:", ret.value.err === null);
  } catch (err: any) {
    console.error("[Holder] Error during refund process: ", err?.message || err);
    
    // Retry once with fresh blockhash if blockhash is stale
    if (err?.message?.includes("blockhash not found") || err?.message?.includes("Blockhash not found")) {
      try {
        console.log("[Holder] Retrying refund with fresh blockhash...");
        
        let transferIxs: TransactionInstruction[] = [];
        for (let i = 0; i < subWallets.length; i++) {
          const balance = await connection.getBalance(subWallets[i].publicKey);
          if (balance > 5000) {
            transferIxs.push(
              SystemProgram.transfer({
                fromPubkey: subWallets[i].publicKey,
                toPubkey: mainWallet.publicKey,
                lamports: balance,
              })
            );
          }
        }
        
        if (transferIxs.length > 0) {
          const transferTx = await makeVersionedTransactionsWithMultiSign(connection, [...subWallets, mainWallet], transferIxs);
          const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
          transferTx.message.recentBlockhash = recentBlockhash;
          transferTx.sign([...subWallets, mainWallet]);
          
          let txid = await connection.sendTransaction(transferTx, {
            maxRetries: 5,
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });

          const ret = await connection.confirmTransaction(
            txid,
            "confirmed"
          );
          console.log("[Holder] Retry refund transaction confirmed: ", txid, "| Success:", ret.value.err === null);
        }
      } catch (retryErr) {
        console.error("[Holder] Retry refund also failed: ", retryErr);
      }
    }
  }
}

// Raydium-specific setup function
async function raydiumSetup(curbotOnSolana: any, baseToken: Token) {
  if (!curbotOnSolana.pairAddress || !curbotOnSolana.poolType || !curbotOnSolana.dexId) {
    return { success: false };
  }

  // const mainWallet = Keypair.fromSecretKey(bs58.decode(curbotOnSolana.mainWallet.privateKey));
  const mainWallet = MAIN_WALLET;

  const poolInfo = await getPoolInfo(
    connection2,
    quoteToken,
    baseToken,
    raydiumSDKList.get(mainWallet.publicKey.toString()),
    curbotOnSolana.poolType.toLowerCase(),
  );

  if (!poolInfo) {
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
    createLookupTable: async (connection: any, mainWallet: any, baseToken: Token) => {
      return createTokenAccountTxPumpFun(
        connection,
        mainWallet,
        baseToken.mint,
        baseToken.programId.equals(TOKEN_2022_PROGRAM_ID)
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

  return {
    success: true,
    additionalParams: {
      pool: pool as AmmImpl | DLMM,
      poolType: curbotOnSolana.poolType as string,
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
export async function raydiumHolderMakerFunc(curbotOnSolana: any) {
  await commonHolderMakerLogic(
    curbotOnSolana,
    raydiumSetup,
    async (connection, wallet, mainWallet, distSol, index, lookupTable, additionalParams) => {
      const { poolInfo, quoteToken, baseToken } = additionalParams;
      return await makeBuyTransactionRaydiumHolder(
        connection,
        wallet,
        mainWallet,
        distSol,
        quoteToken,
        baseToken,
        poolInfo,
        index,
        lookupTable
      );
    }
  );
}

// PumpSwap maker function using the common logic
export async function pumpswapHolderMakerFunc(curbotOnSolana: any) {
  await commonHolderMakerLogic(
    curbotOnSolana,
    pumpswapSetup,
    async (connection, wallet, mainWallet, distSol, index, lookupTable, additionalParams) => {
      const { pairAddress } = additionalParams;
      return await makeBuySellTransactionPumpswapHolder(
        connection,
        pairAddress,
        wallet,
        mainWallet,
        distSol,
        index,
        lookupTable
      );
    }
  );
}

// PumpSwap maker function using the common logic
export async function pumpfunHolderMakerFunc(curbotOnSolana: any) {
  await commonHolderMakerLogic(
    curbotOnSolana,
    pumpfunSetup,
    async (connection, wallet, mainWallet, distSol, index, lookupTable, additionalParams) => {
      const { tokenAddress } = additionalParams;
      return await makeBuySellTransactionPumpFunHolder(
        connection,
        new PublicKey(tokenAddress),
        wallet,
        mainWallet,
        distSol,
        index,
        curbotOnSolana.token?.is2022 || false,
      );
    }
  );
}

// Meteora maker function using the common logic
export async function meteoraHolderMakerFunc(curbotOnSolana: any) {
  await commonHolderMakerLogic(
    curbotOnSolana,
    meteoraSetup,
    async (connection, wallet, mainWallet, distSol, index, lookupTable, additionalParams) => {
      const { pool, poolType } = additionalParams;
      return await makeBuySellTransactionMeteoraHolder(
        connection,
        pool,
        poolType,
        wallet,
        mainWallet,
        distSol,
        index,
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
    'boostType.holderBoost': true,
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
          // [{ text: '🔁 Start again', callback_data: 'start' }],
          [{ text: '❌ Close', callback_data: 'close' }],
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
  // Plan: ${botOnSolana?.depositAmount} SOL for ${botOnSolana?.targetHolder} holders
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
  Plan: ${botOnSolana?.targetHolder} holders
  Used: ${usedSolAmount?.toFixed(9)} SOL`
  );
}
