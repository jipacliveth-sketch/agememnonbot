import { BlockchainProvider, BlockchainTransaction, Balance } from "../provider.interface";
import { env } from "../../config/env";
import { getPlatformDepositAsset } from "../../config/deposit-addresses";
import { formatFixed } from "../../lib/decimal";
import { withRetry } from "../../lib/retry";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a6e4a4f7d";

type RpcResponse<T> = { result?: T; error?: { message?: string } };

/**
 * BSC JSON-RPC provider with strict BEP20 Transfer decoding. The contract
 * address is fixed by configuration and never inferred from user input.
 */
export class BscProvider implements BlockchainProvider {
  readonly network = "BSC" as const;
  private readonly contract: string;

  constructor(private readonly rpcUrl: string = env.BSC_RPC_URL ?? "") {
    this.contract = (env.BSC_USDT_CONTRACT_ADDRESS ??
      getPlatformDepositAsset("BSC", "USDT")?.contractAddress ?? "").toLowerCase();
  }

  async getTransaction(txHash: string): Promise<BlockchainTransaction | null> {
    this.assertConfigured();
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) return null;
    const receipt = await this.rpc<any>("eth_getTransactionReceipt", [txHash]);
    if (!receipt) return null;
    const destination = getPlatformDepositAsset("BSC", "USDT")?.address;
    const transfer = (receipt.logs ?? []).map((log: any) => this.decodeTransfer(log, destination)).find(Boolean);
    if (!destination || !transfer) return null;
    const latest = await this.rpc<string>("eth_blockNumber", []);
    const block = BigInt(receipt.blockNumber);
    const confirmations = block > BigInt(latest) ? 0 : Number(BigInt(latest) - block + 1n);
    const sourceTx = await this.rpc<any>("eth_getTransactionByHash", [txHash]);
    return {
      txHash,
      fromAddress: transfer.from ?? sourceTx?.from ?? null,
      toAddress: destination,
      asset: "USDT",
      amount: formatFixed(BigInt(transfer.rawAmount), 6, 6),
      confirmations,
      successful: receipt.status === "0x1",
      blockTime: null,
    };
  }

  async getAddressBalance(address: string, asset: string): Promise<Balance> {
    this.assertConfigured();
    const destination = getPlatformDepositAsset("BSC", "USDT");
    if (asset === "USDT") {
      if (!destination?.contractAddress || destination.contractAddress.toLowerCase() !== this.contract) {
        throw new Error("BSC USDT contract is not configured.");
      }
      const data = `0x70a08231${address.slice(2).padStart(64, "0")}`;
      const raw = await this.rpc<string>("eth_call", [{ to: this.contract, data }, "latest"]);
      return { asset, amount: formatFixed(BigInt(raw), 6, 6) };
    }
    if (asset === "BNB") {
      const raw = await this.rpc<string>("eth_getBalance", [address, "latest"]);
      return { asset, amount: formatFixed(BigInt(raw), 18, 18) };
    }
    throw new Error(`Unsupported BSC asset: ${asset}`);
  }

  async getConfirmations(txHash: string): Promise<number> {
    return (await this.getTransaction(txHash))?.confirmations ?? 0;
  }

  async watchAddress(address: string): Promise<void> {
    this.assertConfigured();
    await this.getAddressBalance(address, "USDT");
  }

  async scanIncomingTransfers(address: string, asset: string): Promise<BlockchainTransaction[]> {
    this.assertConfigured();
    if (asset !== "USDT") return [];
    const latest = BigInt(await this.rpc<string>("eth_blockNumber", []));
    const fromBlock = latest > 19n ? latest - 19n : 0n;
    const paddedAddress = `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
    const logs = await this.rpc<any[]>("eth_getLogs", [{
      address: this.contract,
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${latest.toString(16)}`,
      topics: [TRANSFER_TOPIC, null, paddedAddress],
    }]);
    const results: BlockchainTransaction[] = [];
    for (const log of logs) {
      const tx = await this.getTransaction(log.transactionHash);
      if (tx) results.push(tx);
    }
    return results;
  }

  async allocateDepositAddress(params: { userId: string; asset: string }) {
    const configured = getPlatformDepositAsset("BSC", params.asset);
    if (!configured) throw new Error(`Unsupported BSC deposit asset: ${params.asset}`);
    return { address: configured.address };
  }

  private decodeTransfer(log: any, destination: string | undefined) {
    if (!destination || String(log.address).toLowerCase() !== this.contract) return null;
    if (String(log.topics?.[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
    const to = `0x${String(log.topics?.[2]).slice(-40)}`;
    if (to.toLowerCase() !== destination.toLowerCase()) return null;
    return {
      from: `0x${String(log.topics?.[1]).slice(-40)}`,
      rawAmount: BigInt(log.data).toString(),
    };
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    return withRetry(async () => {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      });
      if (!response.ok) throw new Error(`BSC RPC HTTP ${response.status}`);
      const body = (await response.json()) as RpcResponse<T>;
      if (body.error) throw new Error(`BSC RPC: ${body.error.message ?? "request failed"}`);
      return body.result as T;
    }, {
      operation: `bsc_rpc.${method}`,
      maxAttempts: 3,
      initialDelayMs: 300,
      maxDelayMs: 3_000,
    });
  }

  private assertConfigured() {
    if (!this.rpcUrl) throw new Error("BscProvider requires BSC_RPC_URL to be configured.");
    if (!this.contract) throw new Error("BSC_USDT_CONTRACT_ADDRESS is not configured.");
  }
}