import type { Metadata } from "next";
import "./globals.css";
import Web3Provider from "@/components/Web3Provider";

export const metadata: Metadata = {
  title: "Authentica — Cryptographic Media Authentication",
  description:
    "Zero-knowledge proof pipeline that cryptographically proves media authenticity without revealing private footage.",
  keywords: ["zk-SNARKs", "deepfake detection", "media authenticity", "blockchain", "EZKL"],
  openGraph: {
    title: "Authentica",
    description: "Prove it's real — cryptographically.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#030712] text-slate-200 antialiased">
        <Web3Provider>{children}</Web3Provider>
      </body>
    </html>
  );
}
