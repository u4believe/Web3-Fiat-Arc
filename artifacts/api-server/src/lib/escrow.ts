import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL!;
const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS!;
const BACKEND_SIGNER_PRIVATE_KEY = process.env.BACKEND_SIGNER_PRIVATE_KEY!;
const USDC_ADDRESS = process.env.USDC_ADDRESS!;

// Minimal ABI for the escrow contract
export const ESCROW_ABI = [
  "function depositByEmailHash(bytes32 emailHash, uint256 amount) external",
  // Legacy: backend calls on behalf of user (no signature required)
  "function claimByEmailHash(bytes32 emailHash, address recipient) external",
  // Phase 5: user calls with backend-signed authorization
  "function claimByEmailHash(bytes32 emailHash, address recipient, bytes calldata signature) external",
  "function getDepositsByEmailHash(bytes32 emailHash) external view returns (uint256)",
  "event Deposited(address indexed sender, bytes32 indexed emailHash, uint256 amount)",
  "event Claimed(bytes32 indexed emailHash, address indexed recipient, uint256 amount)",
];

// Minimal ERC20 ABI
export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) external returns (bool)",
];

export function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(RPC_URL);
}

export function getBackendSigner(): ethers.Wallet {
  const provider = getProvider();
  return new ethers.Wallet(BACKEND_SIGNER_PRIVATE_KEY, provider);
}

export function getEscrowContract(signerOrProvider?: ethers.Signer | ethers.Provider): ethers.Contract {
  const connection = signerOrProvider || getProvider();
  return new ethers.Contract(ESCROW_CONTRACT_ADDRESS, ESCROW_ABI, connection);
}

export function getUsdcContract(signerOrProvider?: ethers.Signer | ethers.Provider): ethers.Contract {
  const connection = signerOrProvider || getProvider();
  return new ethers.Contract(USDC_ADDRESS, ERC20_ABI, connection);
}

export function hashEmail(email: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(email.toLowerCase().trim()));
}

export function parseUsdcAmount(amount: string): bigint {
  // USDC has 6 decimal places
  return ethers.parseUnits(amount, 6);
}

export function formatUsdcAmount(amountWei: bigint): string {
  return ethers.formatUnits(amountWei, 6);
}

export const ESCROW_CONTRACT_ADDRESS_VALUE = ESCROW_CONTRACT_ADDRESS;
export const USDC_ADDRESS_VALUE = USDC_ADDRESS;
