import { AuthPanel } from "../../features/account/AuthPanel";
import { cloudConfigured } from "../../server/auth";

/** Account management is reached from the profile button rather than a ninth sidebar menu. */
export default function AccountPage() { return <><div className="page-eyebrow">ACCOUNT</div><div className="page-heading"><div><h1>프로필·설정</h1><p>내 계정과 프로젝트 저장 방식을 확인하세요.</p></div></div><AuthPanel configured={cloudConfigured()}/></>; }
