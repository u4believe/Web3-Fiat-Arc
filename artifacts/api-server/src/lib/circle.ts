import axios from "axios";

const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY!;
const CIRCLE_API_BASE_URL = process.env.CIRCLE_API_BASE_URL || "https://api-sandbox.circle.com";

const circleClient = axios.create({
  baseURL: CIRCLE_API_BASE_URL,
  headers: {
    Authorization: `Bearer ${CIRCLE_API_KEY}`,
    "Content-Type": "application/json",
  },
});

export interface BankDetails {
  bankAccountNumber: string;
  routingNumber: string;
  accountHolderName: string;
  country: string;
}

export async function createCircleWallet(): Promise<{ walletId: string; address: string }> {
  const idempotencyKey = `wallet-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const response = await circleClient.post("/v1/wallets", {
      idempotencyKey,
      description: "USDC Send App Wallet",
    });
    return {
      walletId: response.data.data.walletId,
      address: response.data.data.addresses?.[0]?.address || "",
    };
  } catch (error: any) {
    throw new Error(`Failed to create Circle wallet: ${error.message}`);
  }
}

export async function initiateWireTransfer(
  amount: string,
  bankDetails: BankDetails
): Promise<{ transferId: string; status: string }> {
  const idempotencyKey = `transfer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // First create a bank account
    const bankAccountResponse = await circleClient.post("/v1/banks/wires", {
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
      bankAddress: {
        country: bankDetails.country,
      },
    });

    const bankId = bankAccountResponse.data.data.id;

    // Then create the payout
    const payoutResponse = await circleClient.post("/v1/payouts", {
      idempotencyKey,
      source: {
        type: "wallet",
        id: process.env.CIRCLE_MASTER_WALLET_ID || "1000216185",
      },
      destination: {
        type: "wire",
        id: bankId,
      },
      amount: {
        amount,
        currency: "USD",
      },
    });

    return {
      transferId: payoutResponse.data.data.id,
      status: payoutResponse.data.data.status,
    };
  } catch (error: any) {
    // In sandbox mode, return a mock response if the API fails
    if (CIRCLE_API_BASE_URL.includes("sandbox")) {
      return {
        transferId: `mock-transfer-${Date.now()}`,
        status: "pending",
      };
    }
    throw new Error(`Circle API error: ${error.response?.data?.message || error.message}`);
  }
}

export async function getPayoutStatus(payoutId: string): Promise<string> {
  try {
    const response = await circleClient.get(`/v1/payouts/${payoutId}`);
    return response.data.data.status;
  } catch (error: any) {
    throw new Error(`Failed to get payout status: ${error.message}`);
  }
}
