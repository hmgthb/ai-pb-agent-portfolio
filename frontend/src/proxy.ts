/** 데모 배포용 비밀번호 한 겹.
 *
 * ⚠️ Next 16에서 `middleware.ts`가 **`proxy.ts`로 이름이 바뀌었다**(기능은 같다).
 *    파일명을 middleware로 되돌리면 조용히 실행되지 않는다 — 인증이 없는 채로 뜬다.
 *
 * `DEMO_USER`·`DEMO_PASSWORD`가 **둘 다 있을 때만** 동작한다. 로컬 개발에는 없으므로
 * 그대로 통과하고, 데모 배포(`docker-compose.demo.yml`)에서만 켜진다.
 *
 * 값이 `.env`에 있어도 **loopback(localhost·127.0.0.1) 접속은 묻지 않는다** — 터널 너머만
 * 막으면 되고, 발표 준비 중 로컬 화면까지 매번 묻는 걸 없애기 위해서다(아래 주석).
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

  // 내 컴퓨터에서 직접 연 화면은 묻지 않는다. 막아야 하는 건 터널 너머에서 오는 요청뿐이고,
  // `.env`에 DEMO_* 값을 넣어 둔 채로 로컬을 열면 발표 준비 중에도 매번 물어 온다.
  //
  // cloudflared는 공개 호스트명(`xxx.trycloudflare.com`)을 Host 헤더에 그대로 실어 보내므로
  // 로컬 접속과 여기서 갈린다. ⚠️ `--http-host-header`로 Host를 덮어쓰면 이 구분이 깨진다 —
  // 터널을 그 옵션으로 띄우지 마라.
  //
  // ⚠️ Host는 클라이언트가 정하는 값이라 단독으로 믿지 않는다. Cloudflare 엣지를 지나온
  //    요청에는 `cf-ray`가 붙으므로, Host가 localhost로 위조돼도 인증을 건다.
  const rawHost = request.headers.get('host') ?? '';
  const hostname = rawHost.startsWith('[')
    ? rawHost.slice(1, rawHost.indexOf(']')) // IPv6는 `[::1]:3000` 형태다
    : rawHost.split(':')[0];
  const viaTunnel = request.headers.has('cf-ray') || request.headers.has('cf-connecting-ip');
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (isLoopback && !viaTunnel) return NextResponse.next();

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
