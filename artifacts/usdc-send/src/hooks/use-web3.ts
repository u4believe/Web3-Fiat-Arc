import { useState, useCallback, useEffect } from "react";
import { BrowserProvider, Contract } from "ethers";

const USDC_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

const ESCROW_ABI = [
  "function depositByEmailHash(bytes32 emailHash, uint256 amount) public",
];

export function useWeb3() {
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detect already-connected wallet on mount
  useEffect(() => {
    if (!window.ethereum) return;

    (async () => {
      try {
        const accounts: string[] = await window.ethereum!.request({ method: "eth_accounts" });
        if (accounts.length > 0) setAddress(accounts[0]);
      } catch {
        // Silently ignore — user hasn't granted access yet
      }
    })();

    // React to account switches / disconnects
    const handleAccountsChanged = (accounts: string[]) => {
      setAddress(accounts.length > 0 ? accounts[0] : null);
    };
    window.ethereum.on("accountsChanged", handleAccountsChanged);
    return () => {
      window.ethereum?.removeListener("accountsChanged", handleAccountsChanged);
    };
  }, []);

  const connectWallet = useCallback(async (): Promise<string | null> => {
    if (!window.ethereum) {
      setError("MetaMask or compatible wallet not found. Please install MetaMask.");
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
      return null;
    } catch (err: any) {
      const msg = err.code === 4001
        ? "Connection rejected. Please approve the wallet request."
        : (err.message || "Failed to connect wallet");
      setError(msg);
      return null;
    } finally {
      setIsConnecting(false);
    }
  }, []);

  /**
   * Executes the two-step on-chain send:
   *   1. ERC-20 approve(escrowContract, amountWei)
   *   2. escrow.depositByEmailHash(emailHash, amountWei)
   *
   * @returns tx hash of the deposit transaction
   */
  const depositToEscrow = useCallback(async (
    contractAddress: string,
    usdcAddress: string,
    emailHash: string,
    amountWei: string,
    onApproved?: () => void,
  ): Promise<string> => {
    if (!window.ethereum) throw new Error("No wallet connected");

    const provider = new BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();

    // Step 1 — approve the escrow contract to spend USDC
    const usdc = new Contract(usdcAddress, USDC_ABI, signer);
    const approveTx = await usdc.approve(contractAddress, amountWei);
    await approveTx.wait();
    onApproved?.();

    // Step 2 — deposit into escrow by emailHash
    const escrow = new Contract(contractAddress, ESCROW_ABI, signer);
    const depositTx = await escrow.depositByEmailHash(emailHash, amountWei);
    const receipt = await depositTx.wait();

    return receipt.hash ?? depositTx.hash;
  }, []);

  return {
    address,
    isConnecting,
    error,
    connectWallet,
    depositToEscrow,
  };
}

// Augment the Window type for TypeScript
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<any>;
      on: (event: string, handler: (...args: any[]) => void) => void;
      removeListener: (event: string, handler: (...args: any[]) => void) => void;
    };
  }
}
