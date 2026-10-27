import { PublicationDetail } from '../../../../features/library/PublicationDetail';
/** A detail URL rechecks collection membership and current publication status. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <PublicationDetail id={(await params).id} kind="project" collection="community"/>;
}
