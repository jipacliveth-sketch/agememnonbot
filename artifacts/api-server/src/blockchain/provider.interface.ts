/**
 * Every network integration (Solana, Ethereum, Base, BSC, ...) implements
 * this interface. Nothing else in the codebase should import a concrete
 * provider directly — resolve providers through the registry in
 * blockchain/registry.ts so the rest of the app stays network-agnostic.
 */

export interface BlockchainTransaction {
  txHash: string;
  fromAddress: string | null;
  toAddress: string | null;
  asset: string;
  amount: string; // decimal string, native units
  confirmations: number;
  successful: boolean;
  blockTime: Date | null;
}

export interface Balance {
  asset: string;
  amount: string;
}

export type Network = "SOLANA" | "ETHEREUM" | "BASE" | "BSC";

export interface BlockchainProvider {
  readonly network: Network;

  getTransaction(txHash: string): Promise<BlockchainTransaction | null>;

  getAddressBalance(address: string, asset: string): Promise<Balance>;

  getConfirmations(txHash: string): Promise<number>;

  /**
   * Registers an address for ongoing monitoring. Implementations may use
   * websocket subscriptions, polling, or a third-party indexer webhook —
   * that choice is entirely internal to the provider.
   */
  watchAddress(address: string): Promise<void>;

  /**
   * Generates (or allocates) a deposit destination for a user. Some
   * providers can derive unique addresses per user; others may return a
   * shared address plus a memo/tag. Both are valid as long as the
   * returned address+memo pair can be uniquely attributed back to a
   * single deposit later.
   */
  allocateDepositAddress(params: {
    userId: string;
    asset: string;
  }): Promise<{ address: string; memo?: string }>;

  /**
   * Optional polling hook. Providers that can scan a chain expose verified
   * incoming transfers; the watcher persists them before crediting anything.
   */
  scanIncomingTransfers?(address: string, asset: string): Promise<BlockchainTransaction[]>;
}
