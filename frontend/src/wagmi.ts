import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { genLayerStudioNet, GENLAYER_RPC_URL } from "./chain";

const connectors = connectorsForWallets(
  [{ groupName: "Installed", wallets: [injectedWallet] }],
  { appName: "Flight Delay Desk", projectId: "flight-delay-desk" }
);

export const config = createConfig({
  connectors,
  chains: [genLayerStudioNet],
  transports: { [genLayerStudioNet.id]: http(GENLAYER_RPC_URL) },
  ssr: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
