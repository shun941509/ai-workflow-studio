import { EditorLoader } from "../../../features/editor/EditorLoader";
import { cloudConfigured } from "../../../server/auth";

/** A query id reopens a local draft; creating a project never requires a fake cloud account. */
export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ draft?: string }> }) { const params = await searchParams; return <EditorLoader draftId={params.draft} cloudConfigured={cloudConfigured()}/>; }
