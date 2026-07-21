import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "리서치 코파일럿 — PB 관리자 콘솔",
  description: "공개 공시·뉴스·지연시세를 멀티에이전트로 분석하는 사내 리서치 워크벤치",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
