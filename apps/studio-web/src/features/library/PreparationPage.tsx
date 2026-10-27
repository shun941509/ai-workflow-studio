import Link from "next/link";
import { Library, ArrowRight } from "lucide-react";

/** Unpublished collections remain explicitly empty, with no fabricated thumbnails or success actions. */
export function PreparationPage({ eyebrow, title, description, official }: { eyebrow: string; title: string; description: string; official?: boolean }) {
  return <><div className="page-eyebrow">{eyebrow}</div><div className="page-heading"><div><h1>{title}</h1><p>{description}</p></div></div><section className="collection-preparing"><span className="collection-icon"><Library size={32}/></span><h2>{official ? "검증된 공식 예제를 준비하고 있습니다" : "공유 자료실을 준비하고 있습니다"}</h2><p>{official ? "실제 사용 검증과 관리자 검수가 끝난 항목만 이곳에 공개됩니다. 아직 게시된 항목은 없습니다." : "프로젝트와 자료의 공유·검수 기능이 준비되면 다른 사용자의 작업을 찾아 활용할 수 있습니다."}</p><Link href="/projects/new" className="button button-primary">내 워크플로 만들기<ArrowRight size={16}/></Link><Link href="/guide" className="text-link">먼저 사용 방법 살펴보기</Link></section></>;
}
