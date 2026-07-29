import type { Metadata } from "next";
import { IBM_Plex_Sans, Inter } from "next/font/google";
import "./globals.css";

/* 서체 — 원본은 바이낸스의 BinanceNova(글) / BinancePlex(숫자)이고, 둘 다 라이선스
   폰트라 `docs/design/DESIGN-binance.md`가 지정한 대체본을 쓴다: Inter ↔ Nova,
   IBM Plex Sans ↔ Plex.
   변수명은 원본 쪽 이름을 따랐다(--font-nova / --font-plex) — 대체본을 갈아끼워도
   dashboard.css의 --font-sans/--font-num 정의는 그대로 두기 위해서다.

   ⚠️ 둘 다 **한글 글리프가 없다.** subsets가 latin이라 한글은 자연히 뒤 시스템 폰트로
      떨어진다(dashboard.css --font-sans의 폴백 체인). 즉 바뀌는 건 숫자·영문이고 한글
      본문 모양은 지금과 같다 — 의도한 것이다. 바이낸스가 서체를 나누는 이유는 "숫자가
      자릿수로 맞아 보이게"이지 본문 인상을 바꾸려는 게 아니다.
   ⚠️ Inter는 가변 폰트라 weight를 안 적어도 되지만 IBM Plex Sans는 **명시해야 한다.**
      여기 없는 굵기를 CSS에서 부르면 브라우저가 합성해 숫자가 뭉갠다. */
const nova = Inter({
  subsets: ["latin"],
  variable: "--font-nova",
  display: "swap",
});
const plex = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex",
  display: "swap",
});

// 탭 제목·링크 미리보기에 나가는 값이다. 화면 안 브랜드(dashboard/page.tsx)와는 별도 문자열이니
// 정체성 문구를 바꿀 때 두 곳을 같이 봐야 한다.
export const metadata: Metadata = {
  title: "AI PB 어시스턴트",
  description:
    "PB가 고객 상담 전에 공개 공시·뉴스·지연시세에서 출처 있는 사실을 확인하는 도구",
};

/* 테마 부트스트랩 — 처음 열면 **라이트**다. 저장된 값이 없을 때 무엇으로 그릴지는
   CSS가 아니라 여기서 정한다: <html>에 data-theme="light"를 **서버가 이미 박아** 두고
   (아래 참조), 다크를 고른 사용자만 첫 페인트 전에 이 스크립트가 되돌린다.
   ⚠️ dashboard.css의 :root는 여전히 다크 토큰이다 — 토큰을 뒤집지 않고 "아무 값도 없을
      때 무엇이 되나"만 바꾼 것이다. 그래서 속성은 두 값 모두에서 **항상 붙어 있다.**
   React 상태로 하면 마운트 뒤에야 바뀌어 화면이 한 번 번쩍인다 — 그래서 body 첫 자식의
   동기 스크립트다(HTML 파싱 중 그 자리에서 실행된다).
   localStorage가 막힌 환경(사생활 보호 모드)에서도 죽지 않게 try로 감싼다. */
const THEME_BOOTSTRAP = `try{if(localStorage.getItem('pb-theme')==='dark'){document.documentElement.dataset.theme='dark'}}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    /* suppressHydrationWarning은 위 부트스트랩 때문이다 — 스크립트가 하이드레이션 **전에**
       <html>의 data-theme을 고쳐 놓으므로 서버 HTML과 클라이언트 DOM이 반드시 어긋난다.
       React가 고칠 수 없는(고쳐서도 안 되는) 의도된 차이라 이 요소에서만 경고를 끈다.
       ⚠️ 이 속성은 자기 요소의 속성 차이 한 겹에만 적용된다 — 자식 트리의 진짜
          하이드레이션 오류는 그대로 보고된다. 아래로 내리지 말 것. */
    <html
      lang="ko"
      /* 기본값이 여기 있다 — CSS :root(다크)를 덮어 첫 화면을 라이트로 만든다.
         page.tsx의 serverTheme()과 반드시 같은 값이어야 토글 라벨이 안 어긋난다. */
      data-theme="light"
      className={`${nova.variable} ${plex.variable}`}
      suppressHydrationWarning
    >
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {children}
      </body>
    </html>
  );
}
