import { BlockchainProvider, BlockchainTransaction, Balance } from "../provider.interface";
import { env } from "../../config/env";
import { getPlatformDepositAsset } from "../../config/deposit-addresses";
import { formatFixed } from "../../lib/decimal";
import { withRetry } from "../../lib/retry";

type RpcResponse<T> = { result?: T; error?: { message?: string } };

/**
 * Solana JSON-RPC provider. It only reports transfers that are actually
 * parsed from a successful transaction and destined for the configured
 * platform address. No user supplied amount or asset is trusted.
 */
export class SolanaProvider implements BlockchainProvider {
  readonly network = "SOLANA" as const;

  constructor(private readonly rpcUrl: string = env.SOLANA_RPC_URL ?? "") {}

  async getTransaction(txHash: string): Promise<BlockchainTransaction | null> {
    this.assertConfigured();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(txHash)) return null;
    const tx = await this.rpc<any>("getTransaction", [
      txHash,
      {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (!tx) return null;

    const destination = getPlatformDepositAsset("SOLANA", "SOL")?.address;
    const transfers = this.findTransfers(tx, destination);
    if (!destination || transfers.length === 0) return null;
    const lamports = transfers.reduce((sum, item) => sum + BigInt(item.lamports), 0n);
    const currentSlot = await this.rpc<number>("getSlot", [{ commitment: "confirmed" }]);
    const confirmations = Math.max(0, currentSlot - Number(tx.slot) + 1);
    return {
      txHash,
      fromAddress: transfers[0].from,
      toAddress: destination,
      asset: "SOL",
      amount: formatFixed(lamports, 9, 9),
      confirmations,
      successful: tx.meta?.err == null,
      blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
    };
  }

  async getAddressBalance(address: string, asset: string): Promise<Balance> {
    this.assertConfigured();
    if (asset !== "SOL") throw new Error(`Unsupported Solana asset: ${asset}`);
    const result = await this.rpc<{ value: number }>("getBalance", [address, { commitment: "finalized" }]);
    return { asset, amount: formatFixed(BigInt(result.value), 9, 9) };
  }

  async getConfirmations(txHash: string): Promise<number> {
    const tx = await this.getTransaction(txHash);
    return tx?.confirmations ?? 0;
  }

  async watchAddress(address: string): Promise<void> {
    this.assertConfigured();
    await this.getAddressBalance(address, "SOL");
  }

  async scanIncomingTransfers(address: string, asset: string): Promise<BlockchainTransaction[]> {
    this.assertConfigured();
    if (asset !== "SOL") return [];
    const signatures = await this.rpc<Array<{ signature: string; err: unknown }>>(
      "getSignaturesForAddress",
      [address, { limit: 25, commitment: "confirmed" }]
    );
    const found: BlockchainTransaction[] = [];
    for (const signature of signatures) {
      if (signature.err) continue;
      const transaction = await this.getTransaction(signature.signature);
      if (transaction?.toAddress === address && transaction.asset === asset) found.push(transaction);
    }
    return found;
  }

  async allocateDepositAddress(params: { userId: string; asset: string }) {
    const configured = getPlatformDepositAsset("SOLANA", params.asset);
    if (!configured) throw new Error(`Unsupported Solana deposit asset: ${params.asset}`);
    return { address: configured.address };
  }

  private findTransfers(tx: any, destination: string | undefined) {
    const all = [
      ...(tx.transaction?.message?.instructions ?? []),
      ...(tx.meta?.innerInstructions ?? []).flatMap((entry: any) => entry.instructions ?? []),
    ];
    return all
      .filter((instruction: any) =>
        instruction?.program === "system" &&
        instruction?.parsed?.type === "transfer" &&
        instruction?.parsed?.info?.destination === destination
      )
      .map((instruction: any) => ({
        from: instruction.parsed.info.source as string,
        lamports: instruction.parsed.info.lamports as number | string,
      }));
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    return withRetry(async () => {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      });
      if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
      const body = (await response.json()) as RpcResponse<T>;
      if (body.error) throw new Error(`Solana RPC: ${body.error.message ?? "request failed"}`);
      return body.result as T;
    }, {
      operation: `solana_rpc.${method}`,
      maxAttempts: 3,
      initialDelayMs: 300,
      maxDelayMs: 3_000,
    });
  }

  private assertConfigured() {
    if (!this.rpcUrl) throw new Error("SolanaProvider requires SOLANA_RPC_URL to be configured.");
  }
}