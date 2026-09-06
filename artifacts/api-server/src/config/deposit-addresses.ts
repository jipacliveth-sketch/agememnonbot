import { Network } from "../blockchain/provider.interface";

/**
 * These are SHARED custodial addresses controlled by the platform — not
 * per-user derived addresses. Every user sees the same address for a
 * given network/asset. Because of that, a deposit CANNOT be attributed
 * to a user purely from the destination address — the user must submit
 * the transaction hash after sending (see bot/handlers/wallet.handler.ts
 * `depositTxHashSubmissionHandler`), and the backend verifies that hash
 * on-chain (destination, asset, amount, confirmations) before crediting.
 *
 * Addresses are case-sensitive on both Solana (base58) and EVM chains
 * (checksum casing) — copied exactly as provided, do not reformat,
 * re-checksum, or lowercase/uppercase them.
 */
export interface PlatformDepositAsset {
  network: Network;
  asset: string;
  address: string;
  displayName: string; // e.g. "USDT (BEP20)" for on-screen clarity
  requiredConfirmations: number;
  contractAddress?: string;
}

export const PLATFORM_DEPOSIT_ASSETS: PlatformDepositAsset[] = [
  {
    network: "SOLANA",
    asset: "SOL",
    address: "D7TwNPt2FE6um6MxX8wJAo1pPqmwP6EpZFF68D2dkYrE",
    displayName: "SOL (Solana)",
    requiredConfirmations: 32,
  },
  {
    network: "BSC",
    asset: "USDT",
    address: "0x66b6c403b307ef563ddb34d75e94a023524035a3",
    displayName: "USDT (BEP20)",
    requiredConfirmations: 15,
    contractAddress: "0x55d398326f99059ff775485246999027b3197955",
  },
];

export function getPlatformDepositAsset(network: Network, asset: string): PlatformDepositAsset | undefined {
  return PLATFORM_DEPOSIT_ASSETS.find((a) => a.network === network && a.asset === asset);
}
