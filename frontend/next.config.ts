import type { NextConfig } from 'next';

/** 데모 배포에서 백엔드를 프론트 뒤로 숨기는 프록시.
 *
 * 로컬 개발은 이 경로를 **타지 않는다** — 브라우저가 `NEXT_PUBLIC_API_BASE_URL`
 * (=`http://localhost:8000`)로 백엔드를 직접 부르기 때문이다. 데모 배포에서만 그 값을
 * 빈 문자열로 두어 호출이 상대경로가 되고, 그때 이 rewrites가 받는다.
 *
 * 얻는 것 셋: 공개 URL이 하나로 준다 · same-origin이라 CORS 설정을 안 건드려도 된다 ·
 * 백엔드가 인터넷에 직접 노출되지 않는다(`src/proxy.ts`의 비밀번호를 우회할 길이 없다).
 */
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? 'http://localhost:8000';

const nextConfig: NextConfig = {
  experimental: {
    /** ⚠️ **없으면 30초에 끊긴다.** Next의 rewrites 프록시 기본 타임아웃이 30초로 박혀 있다
     *  (`next/dist/server/lib/router-utils/proxy-request.js`: `proxyTimeout || 30000`).
     *
     *  이 앱의 긴 요청은 그보다 오래 걸린다: 브리핑 생성 40~50초 · F3 노트 ~100초.
     *  실제로 브리핑이 **백엔드에서는 성공해 DB에 저장됐는데 화면은 500 "생성에 실패했습니다"**
     *  를 띄웠다 — 프록시가 완료 5~10초 전에 연결을 끊었기 때문이다. 크레딧은 이미 나간 뒤라
     *  실패로 보이는 게 더 나쁘다.
     *
     *  ⚠️ 이 키는 **공식 문서에 없다**(config 스키마에만 있다). Next를 올릴 때 사라졌는지
     *     확인할 것 — 조용히 무시되면 증상이 그대로 돌아온다.
     *  로컬 개발은 rewrites를 안 타므로 이 값과 무관하다. */
    proxyTimeout: 300_000,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${BACKEND_ORIGIN}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
