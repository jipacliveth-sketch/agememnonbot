import { BlockchainProvider, Network } from "./provider.interface";

const providers = new Map<Network, BlockchainProvider>();

export function registerProvider(provider: BlockchainProvider) {
  providers.set(provider.network, provider);
}

export function getProvider(network: Network): BlockchainProvider {
  const provider = providers.get(network);
  if (!provider) {
    throw new Error(
      `No blockchain provider registered for network "${network}". ` +
        `Only register providers for networks actually supported in this release.`
    );
  }
  return provider;
}

export function isNetworkSupported(network: Network): boolean {
  return providers.has(network);
}
