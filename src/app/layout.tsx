import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { BRAND_NAME, BRAND_SUBTITLE } from "@/lib/branding";
import { FooterWatermark } from "@/components/footer-watermark";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const pretendard = localFont({
  src: "./fonts/PretendardVariable.woff2",
  variable: "--font-pretendard",
  display: "swap",
  weight: "45 920",
});

export const metadata: Metadata = {
  title: `${BRAND_NAME} 실험 예약 시스템`,
  description: `${BRAND_SUBTITLE} — 실험 예약 시스템`,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} ${pretendard.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <FooterWatermark />
      </body>
    </html>
  );
}
