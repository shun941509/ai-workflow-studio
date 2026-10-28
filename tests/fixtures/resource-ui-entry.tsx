import { createRoot } from 'react-dom/client';
import { ResourceLibrary } from '../../apps/studio-web/src/features/resources/ResourceLibrary';
import { WorkflowEditor } from '../../apps/studio-web/src/features/editor/WorkflowEditor';
import '@studio/ui/tokens.css';
import '../../apps/studio-web/src/app/globals.css';

// Internal browser harness: production components use a local deterministic transport, never production configuration.
const url = new URL(location.href);
createRoot(document.getElementById('root')!).render(url.pathname === '/editor' ? <main className="editor-main"><WorkflowEditor cloudConfigured draftId={url.searchParams.get('draft') ?? undefined} projectId={url.searchParams.get('project') ?? undefined}/></main> : <main style={{ padding: 30 }}><ResourceLibrary configured={url.searchParams.get('configured') !== 'false'}/></main>);
