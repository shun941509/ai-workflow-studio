import { EditorLoader } from "../../../../features/editor/EditorLoader";
import { cloudConfigured } from "../../../../server/auth";

/** Cloud drafts are fetched by an authenticated endpoint and retain optimistic version metadata. */
export default async function EditProjectPage({ params }: { params: Promise<{ id: string }> }) { return <EditorLoader projectId={(await params).id} cloudConfigured={cloudConfigured()}/>; }
