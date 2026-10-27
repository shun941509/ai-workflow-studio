import { PublicationLibrary } from '../../features/library/PublicationLibrary';
/** Only published administrator project metadata belongs in this collection. */
export default function ExamplesPage() { return <PublicationLibrary kind="project" collection="official"/>; }
