import { PublicationLibrary } from '../../../features/library/PublicationLibrary';
/** Only published community project metadata belongs in this collection. */
export default function ExploreProjectsPage() { return <PublicationLibrary kind="project" collection="community"/>; }
