import dotenv from "dotenv";
import bs58 from "bs58";
import {
  Keypair,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} from "@solana/web3.js";

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createAndSendBundle, updateRecentBlockHash } from "./utils/common";
import { getWallets } from "./bot/action";
import { SPL_ACCOUNT_LAYOUT } from "@raydium-io/raydium-sdk";
import { MAX_WALLET_COUNT } from "./bot/const";
import { connectDatabase } from "./database/config";

dotenv.config();

export const networkName = process.env.SOLANA_RPC_URL || "mainnet";
console.log("RPC:", networkName);

export const connection = new Connection(networkName, "finalized");

const MAIN_WALLET_KEY = process.env.MAIN_WALLET_KEY
  ? process.env.MAIN_WALLET_KEY
  : "";
const MAIN_WALLET = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_KEY));
const WALLET_COUNT_PER_TX = 5;
const TX_COUNT_PER_BUNDLE = 4;

export const closeWallets = async () => {
  console.log("closeWallets")
  let walletIdx = 0;

  console.log("MAX_WALLET_COUNT:", MAX_WALLET_COUNT);
  console.log("MAIN_WALLET:", MAIN_WALLET.publicKey.toString());

  const tokenMintKeyList: PublicKey[] = [];

  while (walletIdx < MAX_WALLET_COUNT) {
    const versionedTx = [];
    const walletList = [];
    let idxTx = 0;

    while (idxTx < TX_COUNT_PER_BUNDLE && walletIdx < MAX_WALLET_COUNT) {
      const wallets = await getWallets(walletIdx, WALLET_COUNT_PER_TX);
      const signers: Keypair[] = [];

      const instructions = [];

      for (const wallet of wallets) {
        if (!wallet) continue;
        const balance = await connection.getBalance(wallet.publicKey);
        const accountList = await getOwnerTokenAccounts(wallet);
        const currentInst = instructions.length;

        if (balance == 0 && accountList.length == 0) {
          continue;
        }

        if (balance > 0) {
          console.log("wallet.publicKey and Balance", wallet.publicKey.toString(), balance);
          instructions.push(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: MAIN_WALLET.publicKey,
              lamports: balance,
            })
          );
        }

        for (const account of accountList) {
          console.log("wallet.publicKey and token account Balance", wallet.publicKey.toString(), balance);
          const dstKey = await getAssociatedTokenAddress(
            account.mintKey,
            MAIN_WALLET.publicKey
          );

          const tokenAccountInfo = await connection.getAccountInfo(
            dstKey,
            "finalized"
          );

          if (!tokenAccountInfo) {
            if (tokenMintKeyList.indexOf(account.mintKey) == -1) {
              tokenMintKeyList.push(account.mintKey);

              instructions.push(
                createAssociatedTokenAccountIdempotentInstruction(
                  MAIN_WALLET.publicKey,
                  dstKey,
                  MAIN_WALLET.publicKey,
                  account.mintKey
                )
              );
            }
          }

          if (account.amount > 0) {
            instructions.push(
              createTransferCheckedInstruction(
                account.pubKey,
                account.mintKey,
                dstKey,
                wallet.publicKey,
                Math.floor(account.amount * 10 ** account.decimals),
                account.decimals
              )
            );
          } else {
            instructions.push(
              createCloseAccountInstruction(
                account.pubKey,
                MAIN_WALLET.publicKey,
                wallet.publicKey,
                [wallet]
              )
            );
          }
        }

        // console.log("instructions.length", instructions.length);

        if (currentInst < instructions.length) signers.push(wallet);
      }

      if (instructions.length > 0) {
        const tx = await getVersionedTransaction(
          connection,
          MAIN_WALLET.publicKey,
          instructions
        );

        versionedTx.push(tx);

        walletList.push(signers);

        idxTx++;
      }

      walletIdx += WALLET_COUNT_PER_TX;

      console.log("transfer processed", walletIdx);
    }

    console.log("transfer processed", walletIdx);

    if (versionedTx.length > 0) {
      // console.log("versionedTx", versionedTx.length);

      let res = false;

      await updateRecentBlockHash(connection, versionedTx);

      for (idxTx = 0; idxTx < versionedTx.length; idxTx++) {
        // console.log("idxTx", idxTx);
        const wallets = walletList[idxTx];
        wallets.push(MAIN_WALLET);

        versionedTx[idxTx].sign(wallets);

        const simRes = await connection.simulateTransaction(versionedTx[idxTx]);
        versionedTx[idxTx].serialize();

        if (simRes.value.err) {
          console.log("simRes", simRes, simRes.value.err);
        }
      }

      res = await createAndSendBundle(connection, MAIN_WALLET, versionedTx);
    }
  }
  return 1;
};
connectDatabase(() => { });
// closeWallets();

async function getVersionedTransaction(
  connection: Connection,
  ownerPubkey: PublicKey,
  instructionArray: TransactionInstruction[]
) {
  const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const messageV0 = new TransactionMessage({
    payerKey: ownerPubkey,
    instructions: instructionArray,
    recentBlockhash: recentBlockhash,
  }).compileToV0Message();

  return new VersionedTransaction(messageV0);
}

const getOwnerTokenAccounts = async (keypair: Keypair) => {
  const walletTokenAccount = await connection.getParsedTokenAccountsByOwner(
    keypair.publicKey,
    {
      programId: TOKEN_PROGRAM_ID,
    }
  );

  return walletTokenAccount.value.map((i) => ({
    pubKey: i.pubkey,
    mintKey: new PublicKey(i.account.data.parsed.info.mint),
    amount: Number(i.account.data.parsed.info.tokenAmount.uiAmount),
    decimals: Number(i.account.data.parsed.info.tokenAmount.decimals),
  }));
};