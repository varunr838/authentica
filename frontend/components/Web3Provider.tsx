"use client";
/**
 * components/Web3Provider.tsx
 * Wraps the app with wagmi + TanStack Query context.
 * Must be a Client Component because wagmi uses browser APIs.
 */
import { WagmiProvider }         from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig }           from "@/utils/web3Config";
import { useState }              from "react";

export default function Web3Provider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
