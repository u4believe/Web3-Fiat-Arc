import { useState, useCallback } from "react";
import { BrowserProvider, Contract } from "ethers";

const USDC_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)"
];

const ESCROW_ABI = [
  "function depositByEmailHash(bytes32 emailHash, uint256 amount) public"
];

export function useWeb3() {
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectWallet = useCallback(async () => {
    if (!window.ethereum) {
      setError("MetaMask or compatible wallet not found.");
      return null;
    }

    try {
      setIsConnecting(true);
      setError(null);
      const provider = new BrowserProvider(window.ethereum);
      const accounts = await provider.send("eth_requestAccounts", []);
      if (accounts.length > 0) {
        setAddress(accounts[0]);
        return accounts[0];
      }
    } catch (err: any) {
      setError(err.message || "Failed to connect wallet");
    } finally {
      setIsConnecting(false);
    }
    return null;
  }, []);

  const depositToEscrow = useCallback(async (
    contractAddress: string,
    usdcAddress: string,
    emailHash: string,
    amountWei: string
  ) => {
    if (!window.ethereum) throw new Error("Wallet not connected");

    const provider = new BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();

    try {
      // 1. Approve USDC
      const usdc = new Contract(usdcAddress, USDC_ABI, signer);
      const approveTx = await usdc.approve(contractAddress, amountWei);
      await approveTx.wait();

      // 2. Deposit to Escrow
      const escrow = new Contract(contractAddress, ESCROW_ABI, signer);
      const depositTx = await escrow.depositByEmailHash(emailHash, amountWei);
      await depositTx.wait();

      return depositTx.hash;
    } catch (err: any) {
      console.error("Deposit failed:", err);
      throw new Error(err.reason || err.message || "Transaction failed");
    }
  }, []);

  return {
    address,
    isConnecting,
    error,
    connectWallet,
    depositToEscrow
  };
}
