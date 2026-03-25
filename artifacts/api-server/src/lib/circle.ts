import axios from "axios";
import { ethers } from "ethers";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY!;
const CIRCLE_API_BASE_URL = process.env.CIRCLE_API_BASE_URL || "https://api-sandbox.circle.com";
const CIRCLE_ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET;
let CIRCLE_WALLET_SET_ID = process.env.CIRCLE_WALLET_SET_ID;

const circleHttpClient = axios.create({
  baseURL: CIRCLE_API_BASE_URL,
  headers: {
    Authorization: `Bearer ${CIRCLE_API_KEY}`,
    "Content-Type": "application/json",
  },
});

let _dcwClient: ReturnType<typeof initiateDeveloperControlledWalletsClient> | null = null;

function getDcwClient() {
  if (!CIRCLE_ENTITY_SECRET) return null;
  if (!_dcwClient) {
    _dcwClient = initiateDeveloperControlledWalletsClient({
      apiKey: CIRCLE_API_KEY,
      entitySecret: CIRCLE_ENTITY_SECRET,
    });
  }
  return _dcwClient;
}

async function ensureWalletSet(): Promise<string | null> {
  if (CIRCLE_WALLET_SET_ID) return CIRCLE_WALLET_SET_ID;
  const client = getDcwClient();
  if (!client) return null;

  try {
    const res = await client.createWalletSet({ name: "USDC App User Wallets" });
    const id = (res.data as any)?.walletSet?.id || (res as any)?.walletSet?.id;
    if (id) {
      CIRCLE_WALLET_SET_ID = id;
      return id;
    }
  } catch (e: any) {
    console.warn("[Circle DCW] Could not create wallet set:", e?.message || e);
  }
  return null;
}

function derivePlatformWallet(userId: number): { walletId: string; address: string } {
  const seed = Buffer.from(
    (process.env.BACKEND_SIGNER_PRIVATE_KEY || "").replace("0x", "").padStart(64, "0"),
    "hex",
  );
  const hdNode = ethers.HDNodeWallet.fromSeed(seed);
  const derived = hdNode.derivePath(`m/44'/60'/0'/0/${userId}`);
  return { walletId: `platform-${userId}`, address: derived.address };
}

export async function createUserCircleWallet(
  userId: number,
): Promise<{ walletId: string; address: string }> {
  const client = getDcwClient();
  const walletSetId = await ensureWalletSet();

  if (client && walletSetId) {
    try {
      const res = await client.createWallets({
        blockchains: ["MATIC-AMOY" as any],
        count: 1,
        walletSetId,
      });
      const wallets = (res.data as any)?.wallets || (res as any)?.wallets || [];
      const wallet = wallets[0];
      if (wallet?.id && wallet?.address) {
        return { walletId: wallet.id, address: wallet.address };
      }
    } catch (e: any) {
      console.warn("[Circle DCW] Wallet creation failed, using platform HD wallet:", e?.message || e);
    }
  }

  return derivePlatformWallet(userId);
}

export interface BankDetails {
  bankAccountNumber: string;
  routingNumber: string;
  accountHolderName: string;
  country: string;
}

export async function initiateWireTransfer(
  amount: string,
  bankDetails: BankDetails,
): Promise<{ transferId: string; status: string }> {
  const idempotencyKey = `transfer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  try {
    const bankAccountResponse = await circleHttpClient.post("/v1/banks/wires", {
      idempotencyKey: `bank-${idempotencyKey}`,
      accountNumber: bankDetails.bankAccountNumber,
      routingNumber: bankDetails.routingNumber,
      billingDetails: {
        name: bankDetails.accountHolderName,
        country: bankDetails.country,
        city: "N/A",
        line1: "N/A",
        district: "N/A",
        postalCode: "00000",
      },
      bankAddress: { country: bankDetails.country },
    });

    const bankId = bankAccountResponse.data.data.id;

    const payoutResponse = await circleHttpClient.post("/v1/payouts", {
      idempotencyKey,
      source: {
        type: "wallet",
        id: process.env.CIRCLE_MASTER_WALLET_ID || "1000216185",
      },
      destination: { type: "wire", id: bankId },
      amount: { amount, currency: "USD" },
    });

    return {
      transferId: payoutResponse.data.data.id,
      status: payoutResponse.data.data.status,
    };
  } catch (error: any) {
    if (CIRCLE_API_BASE_URL.includes("sandbox")) {
      return { transferId: `mock-transfer-${Date.now()}`, status: "pending" };
    }
    throw new Error(`Circle API error: ${error.response?.data?.message || error.message}`);
  }
}

export async function getPayoutStatus(payoutId: string): Promise<string> {
  try {
    const response = await circleHttpClient.get(`/v1/payouts/${payoutId}`);
    return response.data.data.status;
  } catch (error: any) {
    throw new Error(`Failed to get payout status: ${error.message}`);
  }
}
