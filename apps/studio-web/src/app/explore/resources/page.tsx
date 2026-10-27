import { PublicationLibrary } from '../../../features/library/PublicationLibrary';
/** Only published community resource metadata belongs in this collection. */
export default function ExploreResourcesPage() { return <PublicationLibrary kind="resource" collection="community"/>; }
