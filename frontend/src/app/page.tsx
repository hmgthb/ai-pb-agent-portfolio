import { redirect } from 'next/navigation';

/** 종목 입력 화면은 대시보드의 "리서치 노트 생성" 카드로 흡수됐다 —
 *  화면이 둘로 갈라져 있던 것을 하나로 합친다(공통 셸). */
export default function Home() {
  redirect('/dashboard');
}
