import { ethers } from "ethers";

export function hashEmail(email: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(email.toLowerCase().trim()));
}

export function parseUsdcAmount(amount: string): bigint {
  return ethers.parseUnits(amount, 6);
}

export function formatUsdcAmount(amountWei: bigint): string {
  return ethers.formatUnits(amountWei, 6);
}
