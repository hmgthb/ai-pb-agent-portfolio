import type { Metadata } from "next";
import "./globals.css";

// 탭 제목·링크 미리보기에 나가는 값이다. 화면 안 브랜드(dashboard/page.tsx)와는 별도 문자열이니
// 정체성 문구를 바꿀 때 두 곳을 같이 봐야 한다.
export const metadata: Metadata = {
  title: "AI PB 어시스턴트",
  description:
    "PB가 고객 상담 전에 공개 공시·뉴스·지연시세에서 출처 있는 사실을 확인하는 도구",
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
