import bs58 from "bs58";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
  LAMPORTS_PER_SOL,
  AddressLookupTableProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";

import {
  getBuyTokenAmountFromSolAmount,
  PumpSdk,
  bondingCurvePda,
  OnlinePumpSdk,
} from "@pump-fun/pump-sdk"; // Import the PumpSdk
import {
  createAndSendBundleEx,
  getRandomNumber,
  getTipInstruction,
  makeVersionedTransactions,
  makeVersionedTransactionsWithMultiSign,
} from "../utils/common";

// Constants
import {
  connection,
  JITO_BUNDLE_TIP,
  MAKER_BOT_MAX_PER_TX,
} from "../bot/const";

// Instantiate SDK
const onlinePumpSdk = new OnlinePumpSdk(connection);
const pumpSdk = new PumpSdk();
const mintSupply = new BN(1000000000000000);
let PUMP_GLOBAL: any;
let PUMP_FEE_CONFIG: any;

(async () => {
  PUMP_GLOBAL = await onlinePumpSdk.fetchGlobal();
  PUMP_FEE_CONFIG = await onlinePumpSdk.fetchFeeConfig();
})();

/**
 * Create a token account for PumpFun
 */
export const createTokenAccountTxPumpFun = async (
  connection: Connection,
  mainWallet: Keypair,
  mint: PublicKey,
  is2022: boolean = false
) => {
  const instructions = [];

  const associatedToken = getAssociatedTokenAddressSync(
    mint,
    mainWallet.publicKey,
    false,
    is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  );

  const info = await connection.getAccountInfo(associatedToken);

  if (!info) {
    console.log("🔃 Pumpfun Creating ATA for mint:", mint.toBase58());
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
    console.log("✅ Pumpfun ATA already exists for mint:", mint.toBase58());
    return "";
  }

  const addressList: any[] = [mint];

  const currentSlot = await connection.getSlot();
  const startSlot = currentSlot - 200;
  const slots = await connection.getBlocks(startSlot, currentSlot);
  if (slots.length < 100) {
    throw new Error(`Could find only ${slots.length} slots on the main fork`);
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

  const ret = await createAndSendBundleEx(connection, mainWallet, [tx]);
  console.log(
    "[pumpfun] Create tokenAccount & addressLookupTable : ",
    ret,
    lookupTableAddress.toBase58()
  );
  if (ret) {
    return lookupTableAddress;
  } else return "";
};

/**
 * Generate buy instructions for PumpFun
 */
export const buyTokenInstructionPumpFun = async (
  connection: Connection,
  mint: PublicKey,
  user: Keypair,
  solAmount: BN,
  slippage: number,
  is2022: boolean
) => {
  try {
    // Fetch necessary account data
    console.log(
      "🔃 Pumpfun Fetching buy state for mint:",
      mint.toBase58(),
      is2022, user.publicKey.toBase58()
    );
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
      await onlinePumpSdk.fetchBuyState(
        mint,
        user.publicKey,
        is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
      );

    let amount = getBuyTokenAmountFromSolAmount({
      global: PUMP_GLOBAL,
      feeConfig: PUMP_FEE_CONFIG,
      mintSupply,
      bondingCurve,
      amount: solAmount,
    });

    let instructions = [];

    // if (!associatedUserAccountInfo) {
    //   console.log(
    //     "🔃 Pumpfun Creating ATA for user:",
    //     user.publicKey.toBase58()
    //   );
    //   const userAta = getAssociatedTokenAddressSync(
    //     mint,
    //     user.publicKey,
    //     false,
    //     is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    //   );
    //   instructions.push(
    //     createAssociatedTokenAccountInstruction(
    //       user.publicKey,
    //       userAta,
    //       user.publicKey,
    //       mint,
    //       is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    //     )
    //   );
    // }

    let buyInstructions = await pumpSdk.buyInstructions({
      global: PUMP_GLOBAL,
      bondingCurveAccountInfo,
      bondingCurve,
      associatedUserAccountInfo,
      mint,
      user: user.publicKey,
      amount,
      solAmount,
      slippage,
      tokenProgram: is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    });

    // instructions = [...instructions, ...buyInstructions];
    instructions = [...buyInstructions];

    return { instructions, minOut: amount };
  } catch (error) {
    console.log("ERROR: Buy token instruction error", error);
    throw error;
  }
};

/**
 * Generate sell instructions for PumpFun
 */
export const sellTokenInstructionPumpFun = async (
  connection: Connection,
  mint: PublicKey,
  user: Keypair,
  amount: BN,
  solAmount: BN,
  slippage: number,
  is2022: boolean
) => {
  try {
    // Fetch necessary account data

    console.log('🔃 Pumpfun Fetching sell state for mint:', mint.toBase58(), is2022, user.publicKey.toBase58());
    const bondingCurveAccountInfo = await connection.getAccountInfo(bondingCurvePda(mint));

    if (!bondingCurveAccountInfo) {
      throw new Error("Bonding curve account info not found");
    }

    const bondingCurve = pumpSdk.decodeBondingCurve(bondingCurveAccountInfo);

    const { isMayhemMode } = bondingCurve;

    const sellInstructions = await pumpSdk.sellInstructions({
      global: PUMP_GLOBAL,
      bondingCurveAccountInfo,
      bondingCurve,
      mint,
      user: user.publicKey,
      amount,
      solAmount,
      slippage,
      tokenProgram: is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
      mayhemMode: isMayhemMode,
    });

    return { instructions: sellInstructions, minOut: solAmount };
  } catch (error) {
    console.log("❌ ERROR: Sell token instruction error", error);
    throw error;
  }
};

/**
 * Make buy/sell transactions for PumpFun volume
 */
export const makeBuySellTransactionPumpFunVolume = async (
  connection: Connection,
  mint: PublicKey,
  payer: Keypair,
  buyer: Keypair,
  solAmount: BN,
  minOutArr: BN[],
  walletNum: number,
  shouldSell: boolean,
  addressLookupTable: string,
  is2022: boolean = false,
  refundSubwalletSol: boolean = true
) => {
  let versionedTransactions = [];
  let isSell = false;

  try {
    // Buy tokens
    const { instructions, minOut } = await buyTokenInstructionPumpFun(
      connection,
      mint,
      buyer,
      solAmount,
      10, // slippage percentage
      is2022
    );
    minOutArr[walletNum] = minOut;
    versionedTransactions.push(...instructions);

    console.log("---------Bought at position:", walletNum, "minOut:", minOut.toString());

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

      // sell current token balance in last Tx
      let tokenBalance = new BN(0);
      if (walletNum == MAKER_BOT_MAX_PER_TX - 1) {
        const associatedToken = getAssociatedTokenAddressSync(
          mint,
          buyer.publicKey,
          false,
          is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
        );
        try {
          const tokenAccount = await getAccount(
            connection,
            associatedToken,
            "confirmed",
            is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
          );
          tokenBalance = new BN(tokenAccount.amount.toString());
          console.log("Current token balance to sell:", tokenBalance.toString());
        } catch (e) {
          console.log("❌ ERROR: Fetch token account error.", e);
        }
      }

      // Sell everything accumulated so far
      let tokenAmountToSell = tokenBalance.add(totalBought);
      console.log("Total token amount to sell:", tokenAmountToSell.toString());

      if (tokenAmountToSell.isZero()) return { volTx: null, isSell: false };

      // Estimate solAmount based on current bonding curve state
      // This is simplified; you may need a better calculation based on your bonding curve
      const estimatedSolReturn = solAmount.mul(new BN(95)).div(new BN(100)); // 95% of input as example
      console.log("Estimated SOL return from sell:", estimatedSolReturn.toString());

      const { instructions: sellInstructions } =
        await sellTokenInstructionPumpFun(
          connection,
          mint,
          buyer,
          tokenAmountToSell,
          estimatedSolReturn,
          10, // slippage percentage
          is2022
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
    console.log(
      "❌ ERROR: Make buy and sell transaction error.",
      error?.message
    );
    // in the case the error is "input token account not found" create token account
    if (error?.message?.includes("input token account not found")) {
      const res = await createTokenAccountTxPumpFun(
        connection,
        buyer,
        mint,
        is2022
      );
      if (res) {
        console.log("✅ Token account created successfully.");
      }
    }
    return { volTx: null, isSell: false };
  }

  // add jito tip instruction to the last transaction
  if (walletNum == 0) {
    const instruction = await getTipInstruction(
      buyer.publicKey,
      JITO_BUNDLE_TIP / LAMPORTS_PER_SOL
    );

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

  return { volTx: tx, isSell };
};

/**
 * Make buy/sell transactions for PumpFun rank
 */
export const makeBuySellTransactionPumpFunBump = async (
  connection: Connection,
  mint: PublicKey,
  payer: Keypair,
  buyer: Keypair,
  solAmount: BN,
  is2022: boolean
) => {
  let versionedTransactions = [];

  try {
    // Buy tokens
    const { instructions, minOut } = await buyTokenInstructionPumpFun(
      connection,
      mint,
      buyer,
      solAmount,
      10, // slippage percentage
      is2022
    );
    versionedTransactions.push(...instructions);

    // Estimate solAmount based on current bonding curve state
    const estimatedSolReturn = solAmount.mul(new BN(95)).div(new BN(100)); // 95% of input as example

    const { instructions: sellInstructions } =
      await sellTokenInstructionPumpFun(
        connection,
        mint,
        buyer,
        minOut, // Sell the amount we just bought
        estimatedSolReturn,
        10, // slippage percentage
        is2022
      );
    versionedTransactions.push(...sellInstructions);
  } catch (error) {
    console.log("ERROR: Make buy and sell transaction error.", error);
    return { bumpTx: null };
  }

  // add jito tip instruction to the last transaction
  const instruction = await getTipInstruction(
    buyer.publicKey,
    JITO_BUNDLE_TIP / LAMPORTS_PER_SOL
  );

  if (!instruction) {
    return { bumpTx: null };
  }
  versionedTransactions.push(instruction);

  const tx = await makeVersionedTransactionsWithMultiSign(
    connection,
    [buyer, payer],
    versionedTransactions
  );

  return { bumpTx: tx };
};

/**
 * Make buy/sell transactions for PumpFun Holder
 */
export const makeBuySellTransactionPumpFunHolder = async (
  connection: Connection,
  mint: PublicKey,
  buyer: Keypair,
  mainWallet: Keypair,
  solAmount: BN,
  walletNum: number,
  is2022: boolean
) => {
  let versionedTransactions = [];
  let isSell = false;

  try {
    // Buy tokens
    const { instructions, minOut } = await buyTokenInstructionPumpFun(
      connection,
      mint,
      buyer,
      solAmount,
      10, // slippage percentage
      is2022
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
    const instruction = await getTipInstruction(
      buyer.publicKey,
      JITO_BUNDLE_TIP / LAMPORTS_PER_SOL
    );

    if (!instruction) {
      return { volTx: null, isSell: false };
    }
    versionedTransactions.push(instruction);
  }

  const tx = await makeVersionedTransactionsWithMultiSign(
    connection,
    [buyer],
    versionedTransactions
  );

  return { volTx: tx, isSell };
};

/**
 * Create a token using PumpFun SDK
 */
export const createPumpFunToken = async (
  connection: Connection,
  mint: Keypair,
  name: string,
  symbol: string,
  uri: string,
  creator: PublicKey,
  user: Keypair
) => {
  try {
    const instruction = await pumpSdk.createInstruction({
      mint: mint.publicKey,
      name,
      symbol,
      uri,
      creator,
      user: user.publicKey,
    });

    const tx = await makeVersionedTransactions(connection, user, [instruction]);

    const result = await createAndSendBundleEx(connection, user, [tx]);
    return { success: result, mint: mint.publicKey };
  } catch (error) {
    console.log("ERROR: Create token error", error);
    return { success: false, mint: mint.publicKey };
  }
};

/**
 * Collect creator fees from PumpFun
 */
export const collectPumpFunCreatorFees = async (
  connection: Connection,
  coinCreator: Keypair
) => {
  try {
    const instructions = await onlinePumpSdk.collectCoinCreatorFeeInstructions(
      coinCreator.publicKey
    );

    const tx = await makeVersionedTransactions(
      connection,
      coinCreator,
      instructions
    );

    const result = await createAndSendBundleEx(connection, coinCreator, [tx]);
    return { success: result };
  } catch (error) {
    console.log("ERROR: Collect creator fees error", error);
    return { success: false };
  }
};

/**
 * Get creator vault balance
 */
export const getPumpFunCreatorVaultBalance = async (
  connection: Connection,
  creator: PublicKey
): Promise<BN> => {
  return await onlinePumpSdk.getCreatorVaultBalance(creator);
};

/**
 * Extend a PumpFun account
 */
export const extendPumpFunAccount = async (
  connection: Connection,
  account: PublicKey,
  user: Keypair
) => {
  try {
    const instruction = await pumpSdk.extendAccountInstruction({
      account,
      user: user.publicKey,
    });

    const tx = await makeVersionedTransactions(connection, user, [instruction]);

    const result = await createAndSendBundleEx(connection, user, [tx]);
    return { success: result };
  } catch (error) {
    console.log("ERROR: Extend account error", error);
    return { success: false };
  }
};

/**
 * Migrate a PumpFun token
 */
export const migratePumpFunToken = async (
  connection: Connection,
  mint: PublicKey,
  user: Keypair
) => {
  try {
    const instruction = await pumpSdk.migrateInstruction({
      withdrawAuthority: PUMP_GLOBAL.withdrawAuthority,
      mint,
      user: user.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    });

    const tx = await makeVersionedTransactions(connection, user, [instruction]);

    const result = await createAndSendBundleEx(connection, user, [tx]);
    return { success: result };
  } catch (error) {
    console.log("ERROR: Migrate token error", error);
    return { success: false };
  }
};
