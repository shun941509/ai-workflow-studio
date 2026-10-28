import { ReviewDetailPanel } from '../../../../features/reviews/ReviewDetailPanel';
/** A route parameter selects a submitted candidate, never a local file or executable preview. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) { return <ReviewDetailPanel id={(await params).id}/>; }
