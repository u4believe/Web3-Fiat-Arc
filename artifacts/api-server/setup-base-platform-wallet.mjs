import { createReadStream } from "fs";
import { createInterface } from "readline";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const env = {};
const rl = createInterface({ input: createReadStream(".env") });
for await (const line of rl) {
  const [k, ...v] = line.split("=");
  if (k && !k.startsWith("#")) env[k.trim()] = v.join("=").trim();
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey: env.CIRCLE_API_KEY,
  entitySecret: env.CIRCLE_ENTITY_SECRET,
});

console.log("Creating dedicated platform wallet on BASE-SEPOLIA...");
const res = await client.createWallets({
  blockchains: ["BASE-SEPOLIA"],
  count: 1,
  walletSetId: env.CIRCLE_WALLET_SET_ID,
});

const wallet = res.data?.wallets?.[0];
if (!wallet) {
  console.log("Failed:", res);
  process.exit(1);
}

console.log("\n✅ Platform wallet created:");
console.log(`  CIRCLE_PLATFORM_WALLET_ID=${wallet.id}`);
console.log(`  CIRCLE_PLATFORM_WALLET_ADDRESS=${wallet.address}`);
console.log("\nAdd these to your .env and also update:");
console.log("  CIRCLE_PRIMARY_BLOCKCHAIN=BASE-SEPOLIA");
console.log("  POLYGON_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e");
