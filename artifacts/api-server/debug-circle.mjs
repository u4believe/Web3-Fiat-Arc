import { createReadStream } from "fs";
import { randomUUID } from "crypto";
import { createInterface } from "readline";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import axios from "axios";

const env = {};
const rl = createInterface({ input: createReadStream(".env") });
for await (const line of rl) {
  const [k, ...v] = line.split("=");
  if (k && !k.startsWith("#")) env[k.trim()] = v.join("=").trim();
}

const API_KEY       = env.CIRCLE_API_KEY;
const ENTITY_SECRET = env.CIRCLE_ENTITY_SECRET;
const WALLET_SET_ID = env.CIRCLE_WALLET_SET_ID;

const http = axios.create({
  baseURL: "https://api.circle.com",
  headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
});

const client = initiateDeveloperControlledWalletsClient({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });

// Token IDs per network (from Circle's registry)
const TOKENS = {
  "MATIC-AMOY":   { usdc: "36b6931a-873a-56a8-8a27-b706b17104ee", native: "0c8f8485-f74f-5e28-80f2-3cc4e80ef71c" },
  "ETH-SEPOLIA":  { usdc: "a4a04090-8a68-5227-a5bb-a41fa1a5adb3", native: null },
  "BASE-SEPOLIA": { usdc: "d6b1a4ca-3c75-5b0a-a4d1-e5823e3c65d8", native: null },
};

// 1. Create fresh wallets on all networks
console.log("=== Creating test wallets on all networks ===");
const wallets = {};
try {
  const r = await client.createWallets({
    blockchains: ["MATIC-AMOY", "ETH-SEPOLIA", "BASE-SEPOLIA"],
    count: 1,
    walletSetId: WALLET_SET_ID,
  });
  for (const w of r.data?.wallets ?? []) {
    wallets[w.blockchain] = { id: w.id, address: w.address };
    console.log(`  ${w.blockchain}: ${w.id}  ${w.address}`);
  }
} catch (e) {
  console.log("Create wallets failed:", e?.response?.data ?? e?.message);
}

// 2. Get USDC token IDs from Circle token registry
console.log("\n=== USDC token IDs from Circle registry ===");
for (const blockchain of ["MATIC-AMOY", "ETH-SEPOLIA", "BASE-SEPOLIA"]) {
  try {
    const r = await http.get("/v1/w3s/tokens", { params: { blockchain } });
    const tokens = r.data?.data?.tokens ?? [];
    const usdc = tokens.find(t => t.symbol === "USDC");
    if (usdc) {
      console.log(`  ${blockchain}: tokenId=${usdc.id}  address=${usdc.tokenAddress}`);
      TOKENS[blockchain].usdc = usdc.id;
    } else {
      console.log(`  ${blockchain}: USDC not found in registry`);
    }
  } catch (e) {
    console.log(`  ${blockchain}: token lookup failed:`, e?.response?.data ?? e?.message);
  }
}

// 3. Try transfer on MATIC-AMOY with existing funded wallet
console.log("\n=== Transfer from existing platform wallet (MATIC-AMOY) ===");
try {
  const res = await client.createTransaction({
    walletId: "9d195900-2aaf-5ec0-bde1-5377449b16da",
    tokenId: TOKENS["MATIC-AMOY"].usdc,
    destinationAddress: "0x12Ae825B99C9044e3DBaFA5b27749cF3F9497BaC",
    amount: ["1"],
    fee: { config: { feeLevel: "MEDIUM" } },
    idempotencyKey: randomUUID(),
  });
  console.log("✅ MATIC-AMOY SUCCESS:", res.data?.transaction?.id);
} catch (e) {
  console.log("❌ MATIC-AMOY:", e?.response?.status ?? e?.code, JSON.stringify(e?.response?.data ?? e?.message));
}

// 4. Try transfer on a freshly-created wallet (any network)
if (wallets["MATIC-AMOY"]) {
  console.log("\n=== Transfer from fresh MATIC-AMOY wallet ===");
  console.log("(This wallet has no funds — testing if the API accepts the request at all)");
  try {
    const res = await client.createTransaction({
      walletId: wallets["MATIC-AMOY"].id,
      tokenId: TOKENS["MATIC-AMOY"].usdc,
      destinationAddress: "0x12Ae825B99C9044e3DBaFA5b27749cF3F9497BaC",
      amount: ["0.01"],
      fee: { config: { feeLevel: "MEDIUM" } },
      idempotencyKey: randomUUID(),
    });
    console.log("✅ New wallet SUCCESS:", res.data?.transaction?.id);
  } catch (e) {
    const status = e?.response?.status ?? e?.code;
    const data = e?.response?.data ?? e?.message;
    console.log(`  Status ${status}:`, JSON.stringify(data));
    if (status !== 2 && JSON.stringify(data) !== '"API parameter invalid"') {
      console.log("  ⚠️  Different error from old wallet! This narrows it down.");
    } else {
      console.log("  Same 'API parameter invalid' — account-wide restriction confirmed");
    }
  }
}

// 5. Raw HTTP POST — expose full response including headers
console.log("\n=== Raw HTTP transfer (full response capture) ===");
try {
  const ciphertext = await client.generateEntitySecretCiphertext();
  const r = await http.post(
    "/v1/w3s/developer/transactions/transfer",
    {
      entitySecretCiphertext: ciphertext,
      idempotencyKey: randomUUID(),
      walletId: "9d195900-2aaf-5ec0-bde1-5377449b16da",
      tokenId: TOKENS["MATIC-AMOY"].usdc,
      destinationAddress: "0x12Ae825B99C9044e3DBaFA5b27749cF3F9497BaC",
      amounts: ["1"],
      feeLevel: "MEDIUM",
    },
    { validateStatus: () => true },  // don't throw on error status
  );
  console.log("HTTP status:", r.status);
  console.log("Response headers:", JSON.stringify(r.headers, null, 2));
  console.log("Response body:", JSON.stringify(r.data, null, 2));
} catch (e) {
  console.log("Raw HTTP failed:", e?.message);
}
