import { ResourceLibrary } from "../../features/resources/ResourceLibrary";
import { cloudConfigured } from "../../server/auth";
/** Private resource creation is available only when an actual account service is configured. */
export default function ResourcesPage() { return <ResourceLibrary configured={cloudConfigured()}/>; }
