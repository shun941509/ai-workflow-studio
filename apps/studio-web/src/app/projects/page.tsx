import Link from "next/link";
import { Plus } from "lucide-react";
import { ProjectLibrary } from "../../features/projects/ProjectLibrary";

/** Local and cloud projects are listed independently to avoid implying server persistence. */
export default function ProjectsPage() { return <><div className="page-eyebrow">MY PROJECTS</div><div className="page-heading"><div><h1>내 프로젝트</h1><p>만들고 있는 워크플로를 이어서 편집하세요.</p></div><Link className="button button-primary" href="/projects/new"><Plus size={16}/>워크플로 만들기</Link></div><ProjectLibrary/></>; }
