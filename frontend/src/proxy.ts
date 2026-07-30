/** 데모 배포용 비밀번호 한 겹.
 *
 * ⚠️ Next 16에서 `middleware.ts`가 **`proxy.ts`로 이름이 바뀌었다**(기능은 같다).
 *    파일명을 middleware로 되돌리면 조용히 실행되지 않는다 — 인증이 없는 채로 뜬다.
 *
 * `DEMO_USER`·`DEMO_PASSWORD`가 **둘 다 있을 때만** 동작한다. 로컬 개발에는 없으므로
 * 그대로 통과하고, 데모 배포(`docker-compose.demo.yml`)에서만 켜진다.
 *
 * 이 한 겹이 화면과 API를 **같이** 덮는 이유: 데모 배포에서는 브라우저가 백엔드를 직접
 * 부르지 않고 `next.config.ts`의 rewrites를 타므로 `/api/*`도 이 프록시를 먼저 지난다.
 * 그래서 백엔드에 따로 인증을 달지 않아도 크레딧을 쓰는 경로가 열리지 않는다
 * (단 **터널은 3000에만 뚫어야 한다** — 8000을 직접 노출하면 이 겹을 우회한다).
 *
 * SSE도 같은 origin이라 브라우저가 인증 헤더를 자동으로 붙인다(`EventSource`는 헤더를
 * 직접 못 싣지만, 한 번 인증한 origin에는 브라우저가 알아서 보낸다).
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const user = process.env.DEMO_USER;
  const pass = process.env.DEMO_PASSWORD;

  // 둘 중 하나라도 비어 있으면 통제를 걸지 않는다 — 로컬 개발 경로다.
  if (!user || !pass) return NextResponse.next();

  const header = request.headers.get('authorization');
  if (header?.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = '';
    }
    const sep = decoded.indexOf(':');
    if (sep !== -1) {
      const gotUser = decoded.slice(0, sep);
      const gotPass = decoded.slice(sep + 1);
      if (gotUser === user && gotPass === pass) return NextResponse.next();
    }
  }

  // ⚠️ 본문 문구는 브라우저 기본 로그인 창에 안 보인다(창은 브라우저가 그린다).
  //    취소했을 때만 보이므로 짧게 둔다.
  return new NextResponse('인증이 필요합니다.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="AI PB Assistant", charset="UTF-8"',
    },
  });
}

export const config = {
  // 정적 자산은 뺀다. 어차피 브라우저가 인증 헤더를 붙여 주지만, 검사할 이유가 없다.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
