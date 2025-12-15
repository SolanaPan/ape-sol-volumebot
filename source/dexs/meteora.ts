import bs58 from "bs58";
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
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as Web3 from '@solana/web3.js';

import {
  MAKER_BOT_MAX_PER_TX,
  JITO_BUNDLE_TIP
} from "../bot/const";
import AmmImpl, { MAINNET_POOL, SwapQuote } from '@meteora-ag/dynamic-amm-sdk';
import { getOrCreateATAInstruction } from '@mercurial-finance/dynamic-amm-sdk/dist/cjs/src/amm/utils';
import DLMM from "@meteora-ag/dlmm-sdk-public";
import { createAndSendBundle, createAndSendBundleEx, formatTime, getRandomNumber, getTipInstruction, getTokenBalance, makeVersionedTransactions, makeVersionedTransactionsWithMultiSign } from "../utils/common";

export const createTokenAccountTxMeteora = async (
  connection: Connection,
  mainWallet: Keypair,
  mint: PublicKey,
  is2022: boolean = false
) => {
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
    console.log("*********** creating meteora ATA...", idx);
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        mainWallet.publicKey,
        associatedToken,
        mainWallet.publicKey,
        mint,
        is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
      )
    );
  } else {
    // console.log("*********** ATA already exists... Returning ...", idx);
    return "";
  }

  // console.log("*********** creating meteora ATA...", idx);
  // const [userToken, ataTokenIx] = await getOrCreateATAInstruction(new PublicKey(mint), mainWallet.publicKey, connection);
  // userToken && ataTokenIx && instructions.push(ataTokenIx);

  const addressList: any[] = [];
  addressList.push(mint)

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

  // instructions.push(lookupTableInst);
  // instructions.push(extendInstruction);

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
  console.log("[meteora] Create tokenAccount & addressLookupTable : ", ret, lookupTableAddress.toBase58());
  if (ret) {
    return lookupTableAddress;
  }
  else return "";
};

export const makeBuySellTransactionMeteoraVolume = async (
  connection: Connection,
  pool: AmmImpl | DLMM,
  poolType: string,
  payer: Keypair,
  buyer: Keypair,
  solAmount: BN,
  minOutArr: BN[],
  walletNum: number,
  shouldSell: boolean,
  addressLookupTable: string,
  refundSubwalletSol: boolean = true
) => {
  let versionedTransactions = [];
  let isSell = false;
  const baseTokenMint = poolType == "DYN" ? (pool as AmmImpl).tokenAMint.address : (pool as DLMM).tokenX.publicKey;
  const baseDecimal = poolType == "DYN" ? (pool as AmmImpl).tokenAMint.decimals : (pool as DLMM).tokenX.decimal;

  try {
    if (!shouldSell) {
      const { instructions, minOut, solAmount: newSolAmount } = await buyTokenInstructionMeteora(
        pool,
        poolType,
        buyer,
        solAmount,
      );
      minOutArr[walletNum] = minOut;
      versionedTransactions.push(...instructions);
      solAmount = !newSolAmount ? solAmount : newSolAmount;

      console.log("Buy Token Amount:", minOutArr[walletNum].toNumber());
    } else if (shouldSell) {
      console.log("Selling at position:", walletNum);
      isSell = true;
      // const tokenBalance = await getTokenBalance(
      //   connection,
      //   baseTokenMint.toString(),
      //   buyer.publicKey,
      //   baseDecimal,
      //   // baseToken.programId == TOKEN_2022_PROGRAM_ID
      // );

      // console.log("tokenBalance", tokenBalance);

      // Calculate total bought amount up to this point
      let totalBought = new BN(0);
      for (let i = 0; i <= walletNum; i++) {
        if (minOutArr[i]) {
          totalBought = totalBought.add(minOutArr[i]);
          minOutArr[i] = new BN(0);
        }
      }

      // Sell everything accumulated so far
      // let tokenAmountToSell = new BN(tokenBalance * 10 ** baseDecimal).add(totalBought);
      let tokenAmountToSell = totalBought;

      if (tokenAmountToSell.isZero()) return { volTx: null, isSell: false };

      console.log("tokenAmountToSell:", tokenAmountToSell.toNumber());
      const { instructions: sellInstructions } = await sellTokenInstructionMeteora(
        pool,
        poolType,
        buyer,
        tokenAmountToSell,
      );

      // Remove duplicate instructions
      if (poolType == "DYN") {
        versionedTransactions.push(...sellInstructions);
      } else if (poolType == "DLMM") {
        // console.log('DLMM---------------------------------------------------')
        versionedTransactions.push(...sellInstructions);
      }
    }

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
  } catch (error: any) {
    console.log("ERROR: Make buy and sell transaction error.", error?.message);
    // in the case the error is "input token account not found" create token account
    if (error?.message?.includes("input token account not found")) {
      const res = await createTokenAccountTxMeteora(
        connection,
        buyer,
        baseTokenMint,
        // baseToken.programId == TOKEN_2022_PROGRAM_ID
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
    solAmount.toNumber()
  );

  // const simRes = await connection.simulateTransaction(tx);
  // if (simRes.value.err) {
  //   console.log("simRes : ", simRes);
  //   return {volTx: null, isSell: false};
  // }

  return { volTx: tx, isSell };
};

export const makeBuySellTransactionMeteoraRank = async (
  connection: Connection,
  pool: AmmImpl | DLMM,
  poolType: string,
  payer: Keypair,
  buyer: Keypair,
  solAmount: BN,
  walletNum: number,
  organicMode: boolean,
  addressLookupTable: string,
  refundSubwalletSol: boolean = true,
) => {
  let versionedTransactions = [];
  let isSell = false;

  try {
    const { instructions, minOut } = await buyTokenInstructionMeteora(
      pool,
      poolType,
      buyer,
      solAmount,
    );
    versionedTransactions.push(...instructions);

    if (organicMode) {
      const randfactor = getRandomNumber(0, 3, 0);
      if (walletNum == randfactor) {
        isSell = true;
        let tokenAmountToSell = minOut;//tokenBalance * 10 ** baseDecimal
        const { instructions: sellInstructions } = await sellTokenInstructionMeteora(
          pool,
          poolType,
          buyer,
          tokenAmountToSell,
        );

        // Remove duplicate instructions
        if (poolType == "DYN") {
          versionedTransactions.push(...sellInstructions.slice(1));
        } else if (poolType == "DLMM") {
          versionedTransactions.push(...sellInstructions.slice(2));
        }
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
  //   console.log("simRes : ", simRes);
  //   return {volTx: null, isSell: false};
  // }

  return { volTx: tx, isSell };
};

export const makeBuySellTransactionMeteoraHolder = async (
  connection: Connection,
  pool: AmmImpl | DLMM,
  poolType: string,
  buyer: Keypair,
  mainWallet: Keypair,
  solAmount: BN,
  walletNum: number,
) => {
  let versionedTransactions = [];
  let isSell = false;

  try {
    // const [userToken, ataTokenIx] = await getOrCreateATAInstruction(new PublicKey(mint), buyer.publicKey, connection);
    // userToken && ataTokenIx && versionedTransactions.push(ataTokenIx);

    const { instructions, minOut } = await buyTokenInstructionMeteora(
      pool,
      poolType,
      buyer,
      solAmount,
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
      lamports: 1000000,
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
  );

  // let simRes = await connection.simulateTransaction(tx);
  // if (simRes.value.err) {
  //   console.log("simRes : ", simRes);
  //   return {volTx: null, isSell: false};
  // }

  return { volTx: tx, isSell };
};

export const buyTokenInstructionMeteora = async (
  pool: AmmImpl | DLMM,
  poolType: string,
  buyer: Keypair,
  solAmount: BN,
  slippage: number = 10,  // 1~100
) => {
  try {
    if (poolType == "DYN") {  // Dynamic AMM
      pool = pool as AmmImpl;
      let [inTokenMint, outTokenMint] = pool.tokenAMint.address.toString() != "So11111111111111111111111111111111111111112" ? [new PublicKey(pool.tokenBMint.address), pool.tokenAMint.address] : [pool.tokenAMint.address, new PublicKey(pool.tokenBMint.address)];

      let swapQuote: SwapQuote | null = null;
      try {
        // Try to get the swap quote
        swapQuote = pool.getSwapQuote(inTokenMint, solAmount, 10);
      } catch (error) {
        // Check if error is related to zero output amount
        if (error instanceof Error && error.message.includes("Swap result in zero")) {
          console.log("Swap would result in zero or below minimum output, skipping");
          swapQuote = null;
          // get quote for sol amount of 10
          try {
            swapQuote = pool.getSwapQuote(new PublicKey(outTokenMint), new BN(10), 100);
            solAmount = swapQuote.swapOutAmount;
            // console.log("Using swap quote for 10 token:", solAmount.toNumber()/LAMPORTS_PER_SOL);
          } catch (quoteError) {
            // console.error("Failed to get swap quote for 10 token:", quoteError);
            return { instructions: [], minOut: new BN(0) };
          }
        } else {
          // Re-throw if it's a different error
          throw error;
        }
      }

      // let swapQuote: SwapQuote = pool.getSwapQuote(inTokenMint, solAmount, 10);

      const swapTx = await pool.swap(
        buyer.publicKey,
        new PublicKey(inTokenMint),
        solAmount,
        swapQuote ? (swapQuote.minSwapOutAmount.isZero() ? new BN(10) : swapQuote.minSwapOutAmount) : new BN(10),
      );

      const swapInstructions = swapTx.instructions.filter(Boolean);

      return { instructions: swapInstructions, minOut: swapQuote ? (swapQuote.minSwapOutAmount.isZero() ? new BN(10) : swapQuote.minSwapOutAmount) : new BN(10), solAmount: solAmount };
    } else if (poolType == "DLMM") {
      pool = pool as DLMM;
      const binArrays = await pool.getBinArrays();
      // Swap quote
      const swapAtoB = pool.tokenX.publicKey.toString() == "So11111111111111111111111111111111111111112 " ? true : false;
      const swapQuote = swapAtoB ? await pool.swapQuote(solAmount, true, new BN(5), binArrays) : await pool.swapQuote(solAmount, false, new BN(5), binArrays);
      // Swap
      const swapTx = await pool.swap({
        inToken: swapAtoB ? pool.tokenX.publicKey : pool.tokenY.publicKey,
        binArraysPubkey: swapQuote.binArraysPubkey,
        inAmount: solAmount,
        lbPair: pool.pubkey,
        user: buyer.publicKey,
        minOutAmount: swapQuote.minOutAmount,
        outToken: swapAtoB ? pool.tokenY.publicKey : pool.tokenX.publicKey,
      });

      const swapInstructions = swapTx.instructions.filter(Boolean);

      return { instructions: swapInstructions, minOut: swapQuote.minOutAmount };
    }
    return { instructions: [], minOut: new BN(0) };
  } catch (error) {
    console.log("ERROR: buyTokenInstructionMeteora error.", error);
    return { instructions: [], minOut: new BN(0) };
  }
}

export const sellTokenInstructionMeteora = async (
  pool: AmmImpl | DLMM,
  poolType: string,
  buyer: Keypair,
  baseAmount: BN,
  slippage: number = 10,  // 1~100
) => {
  try {
    if (poolType == "DYN") {  // Dynamic AMM
      pool = pool as AmmImpl;
      let [inTokenMint, outTokenMint] = pool.tokenAMint.address.toString() == "So11111111111111111111111111111111111111112" ? [new PublicKey(pool.tokenBMint.address), pool.tokenAMint.address] : [pool.tokenAMint.address, new PublicKey(pool.tokenBMint.address)];
      let swapQuote: SwapQuote = pool.getSwapQuote(inTokenMint, baseAmount, 100);

      const swapTx = await pool.swap(
        buyer.publicKey,
        new PublicKey(inTokenMint),
        baseAmount,
        swapQuote.minSwapOutAmount,
      );

      const swapInstructions = swapTx.instructions.filter(Boolean);

      return { instructions: swapInstructions, minOut: swapQuote.minSwapOutAmount };
    } else if (poolType == "DLMM") {
      pool = pool as DLMM;
      const binArrays = await pool.getBinArrays();
      // Swap quote
      const swapAtoB = pool.tokenX.publicKey.toString() != "So11111111111111111111111111111111111111112 " ? true : false;
      const swapQuote = swapAtoB ? await pool.swapQuote(baseAmount, true, new BN(5), binArrays) : await pool.swapQuote(baseAmount, false, new BN(5), binArrays);
      // Swap
      const swapTx = await pool.swap({
        inToken: swapAtoB ? pool.tokenX.publicKey : pool.tokenY.publicKey,
        binArraysPubkey: swapQuote.binArraysPubkey,
        inAmount: baseAmount,
        lbPair: pool.pubkey,
        user: buyer.publicKey,
        minOutAmount: swapQuote.minOutAmount,
        outToken: swapAtoB ? pool.tokenY.publicKey : pool.tokenX.publicKey,
      });

      const swapInstructions = swapTx.instructions.filter(Boolean);

      return { instructions: swapInstructions, minOut: swapQuote.minOutAmount };
    }
    return { instructions: [], minOut: new BN(0) };
  } catch (error) {
    console.log("ERROR: sellTokenInstructionMeteora error.", error);
    return { instructions: [], minOut: new BN(0) };
  }
}

export const initMeteoraBuy = async (
  connection: Connection,
  pool: AmmImpl | DLMM,
  poolType: string,
  mainWallet: Keypair
) => {
  // send initial buy transaction for main wallet
  if (pool != null) {
    const { instructions, minOut } = await buyTokenInstructionMeteora(
      pool,
      poolType,
      mainWallet,
      new BN(100),
    );

    // const mint = poolType == "DYN" ? (pool as AmmImpl).tokenAMint.address : (pool as DLMM).tokenX.publicKey;

    // const [userToken, ataTokenIx] = await getOrCreateATAInstruction(new PublicKey(mint), mainWallet.publicKey, connection);
    // userToken && ataTokenIx && instructions.unshift(ataTokenIx);

    // send transaction
    const tx = new Web3.Transaction().add(...instructions);
    tx.feePayer = mainWallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    try {
      Web3.sendAndConfirmTransaction(
        connection,
        tx,
        [mainWallet],
        {
          maxRetries: 10,
          skipPreflight: false,
          commitment: 'confirmed',
          preflightCommitment: 'confirmed',
        }
      ).then((signature) => {
        console.log("✅ initMeteoraBuy succeed!");
        return true;
      }).catch((error) => {
        console.error('❌ Buy TXN with main wallet failed 1:', error);
        console.log("[initMeteoraBuy] minOut:", minOut.toNumber());
      });
    } catch (error) {
      console.error('❌ Buy TXN with main wallet failed 2:', error);
    }
  }

  console.log("❌ initMeteoraBuy failed!");
  return false;
}