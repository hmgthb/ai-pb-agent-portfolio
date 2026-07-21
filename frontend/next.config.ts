import type { NextConfig } from "next";

// 대시보드는 시안 파일(docs/design/pb-admin-dashboard.html)이 그대로 실화면이라,
// 프론트로 복사하지 않고 백엔드가 서빙하는 것을 프록시한다 — 복사본이 없으니
// 시안과 실화면이 갈라지지 않는다. Next로 포팅하면 이 rewrite는 지운다.
// 도커 안에서는 서비스명(backend)으로, 로컬 실행에서는 localhost로 붙는다.
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/dashboard", destination: `${BACKEND_ORIGIN}/dashboard` }];
  },
};

export default nextConfig;
