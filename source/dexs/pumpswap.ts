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
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

import {
  connection,
  JITO_BUNDLE_TIP,
  MAKER_BOT_MAX_PER_TX
} from "../bot/const";

import { createAndSendBundleEx, getRandomNumber, getTipInstruction, getTokenBalance, makeVersionedTransactions, makeVersionedTransactionsWithMultiSign } from "../utils/common";
import { buyQuoteInput, OnlinePumpAmmSdk, PumpAmmSdk, sellBaseInput } from "@pump-fun/pump-swap-sdk";
import { Token } from "@raydium-io/raydium-sdk";

// Initialize SDK
const onlinePumpAmmSdk = new OnlinePumpAmmSdk(connection);
const pumpAmmSdk = new PumpAmmSdk();

const MAIN_WALLET_KEY = process.env.MAIN_WALLET_KEY
  ? process.env.MAIN_WALLET_KEY
  : "";
const MAIN_WALLET = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_KEY));

export const createTokenAccountTxPumpswap = async (
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
    console.log("🔃 PumpSwap Creating ATA for mint:", mint.toBase58());
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
    // console.log("*********** pumpswap ATA already exists... Returning...");
    return "";
  }

  const addressList: any[] = [];
  // if (poolType == "AMM") {
  addressList.push(mint)
  addressList.push(mainWallet.publicKey)
  addressList.push(associatedToken)
  addressList.push(is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID)
  addressList.push(NATIVE_MINT)

  // addressList.push(poolKeys.programId);
  // addressList.push(poolKeys.id);
  // addressList.push(poolKeys.mintA.address);
  // addressList.push(poolKeys.mintA.programId);
  // addressList.push(poolKeys.mintB.address);
  // addressList.push(poolKeys.mintB.programId);
  // }

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

  console.log("🔎  Creating address lookup table...", tx.serialize().length);

  const ret = await createAndSendBundleEx(connection, mainWallet, [tx]);
  console.log("[pumpswap] Create tokenAccount & addressLookupTable : ", ret, lookupTableAddress.toBase58());
  if (ret) {
    return lookupTableAddress.toBase58();
  }
  else return "";
};

export const makeBuySellTransactionPumpswapVolume = async (
  connection: Connection,
  pool: PublicKey,
  payer: Keypair,
  buyer: Keypair,
  solAmount: BN,
  minOutArr: BN[],
  baseToken: Token,
  baseDecimal: number,
  walletNum: number,
  shouldSell: boolean,
  addressLookupTable: string,
  refundSubwalletSol: boolean = true
) => {
  let versionedTransactions = [];
  let isSell = false;

  try {

    // if (!shouldSell) {
      const { instructions, minOut } = await buyTokenInstructionPumpswap(
        pool,
        buyer,
        solAmount,
        10
      );
      minOutArr[walletNum] = minOut;
      versionedTransactions.push(...instructions);
    // } else {
    //   minOutArr[walletNum] = new BN(0);
    // }

    // console.log("Buy Token Amount:", minOutArr[walletNum].toNumber());

    if (shouldSell) {
      console.log("Selling at position:", walletNum);
      isSell = true;

      let tokenBalance = 0;

      if (walletNum == MAKER_BOT_MAX_PER_TX - 1) {
        tokenBalance = await getTokenBalance(
          connection,
          baseToken.mint.toString(),
          buyer.publicKey,
          baseDecimal,
          baseToken.programId == TOKEN_2022_PROGRAM_ID
        );

        console.log("tokenBalance", tokenBalance);
      }

      // Calculate total bought amount up to this point
      let totalBought = new BN(0);
      for (let i = 0; i <= walletNum; i++) {
        if (minOutArr[i]) {
          totalBought = totalBought.add(minOutArr[i]);
          minOutArr[i] = new BN(0);
        }
      }

      // Sell everything accumulated so far
      let tokenAmountToSell = new BN(tokenBalance * 10 ** baseDecimal).add(totalBought);

      if (tokenAmountToSell.isZero()) return { volTx: null, isSell: false };

      // console.log("tokenAmountToSell:", tokenAmountToSell.toNumber());
      const { instructions: sellInstructions } = await sellTokenInstructionPumpswap(
        pool,
        buyer,
        tokenAmountToSell,
        10
      );
      versionedTransactions.push(...sellInstructions);
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
      const res = await createTokenAccountTxPumpswap(
        connection,
        buyer,
        baseToken.mint,
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

  // console.log("📦 Total instructions:", versionedTransactions.length);

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

export const makeBuySellTransactionPumpswapRank = async (
  connection: Connection,
  poolAddr: PublicKey,
  payer: Keypair,
  buyer: Keypair,
  solAmount: BN,
  walletNum: number,
  organicMode: boolean,
  addressLookupTable: string,
  refundSubwalletSol: boolean = true
) => {
  let versionedTransactions = [];
  let isSell = false;

  try {
    const { instructions, minOut } = await buyTokenInstructionPumpswap(
      poolAddr,
      buyer,
      solAmount,
      20
    );

    if (organicMode) {
      const randfactor = getRandomNumber(1, 3, 0);
      if (walletNum == randfactor) {
        isSell = true;
        let tokenAmountToSell = minOut;//tokenBalance * 10 ** baseDecimal
        const { instructions: sellInstructions } = await sellTokenInstructionPumpswap(
          poolAddr,
          buyer,
          tokenAmountToSell,
          20
        );
        versionedTransactions.push(...sellInstructions);
      } else {
        versionedTransactions.push(...instructions);
      }
    } else {
      versionedTransactions.push(...instructions);
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
  //   // return {volTx: null, isSell: false};
  // }

  return { volTx: tx, isSell };
};

/**
 * Creates a buy and sell transaction for PumpSwap Holder
 */
export const makeBuySellTransactionPumpswapHolder = async (
  connection: Connection,
  poolAddr: PublicKey,
  buyer: Keypair,
  mainWallet: Keypair,
  solAmount: BN,
  walletNum: number,
  addressLookupTable: string,
) => {
  let versionedTransactions = [];
  let isSell = false;

  try {
    const { instructions, minOut } = await buyTokenInstructionPumpswap(
      poolAddr,
      buyer,
      solAmount,
      10
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
      lamports: 2000000,
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
  //   return { volTx: null, isSell: false };
  // }

  return { volTx: tx, isSell };
};

export const buyTokenInstructionPumpswap = async (
  poolKey: PublicKey,
  buyer: Keypair,
  maxSolCost: BN,
  slippage: number = 10,  // 1~100
) => {
  // Quote to Base swap (⬇️)
  const swapSolanaState = await onlinePumpAmmSdk.swapSolanaState(poolKey, buyer.publicKey);
  const {
    baseMint,
    baseMintAccount,
    feeConfig,
    globalConfig,
    pool,
    poolBaseAmount,
    poolQuoteAmount,
  } = swapSolanaState;
  const { coinCreator, creator } = pool;
  const quote = maxSolCost.muln(100).divn(100 + slippage)

  const { base, maxQuote } = buyQuoteInput({
    quote,
    slippage,
    baseReserve: poolBaseAmount,
    quoteReserve: poolQuoteAmount,
    baseMintAccount,
    baseMint,
    coinCreator,
    creator,
    feeConfig,
    globalConfig,
  });

  const swapInstructions = await pumpAmmSdk.buyBaseInput(swapSolanaState, base, slippage)

  return { instructions: swapInstructions, minOut: base };
}

export const sellTokenInstructionPumpswap = async (
  poolKey: PublicKey,
  buyer: Keypair,
  baseAmount: BN,
  slippage: number = 10,  // 1~100
) => {
  // Base to Quote swap (⬆️)
  const swapSolanaState = await onlinePumpAmmSdk.swapSolanaState(poolKey, buyer.publicKey);
  const {
    baseMint,
    baseMintAccount,
    feeConfig,
    globalConfig,
    pool,
    poolBaseAmount,
    poolQuoteAmount,
  } = swapSolanaState;
  const { coinCreator, creator } = pool;

  const { minQuote } = sellBaseInput({
    base: baseAmount,
    slippage,
    baseReserve: poolBaseAmount,
    quoteReserve: poolQuoteAmount,
    baseMintAccount,
    baseMint,
    coinCreator,
    creator,
    feeConfig,
    globalConfig,
  });

  const swapInstructions = await pumpAmmSdk.sellBaseInput(swapSolanaState, baseAmount, slippage);

  return { instructions: swapInstructions, minOut: minQuote };
}