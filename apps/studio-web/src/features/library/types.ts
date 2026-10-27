/** The browser receives reviewed metadata only, never source snapshots, owner identity or private object paths. */
export interface Publication {
  id: string; kind: 'project' | 'resource'; title: string; description: string;
  artifactSha256: string; manifestSha256: string; official: boolean; publishedAt: string;
}
export interface PublicationPage { items: Publication[]; nextCursor: string | null }
export type Collection = 'official' | 'community';
export type PublicationKind = Publication['kind'];

/** Official and community routes remain distinct even when their titles or source projects match. */
export function collectionPath(kind: PublicationKind, collection: Collection): string {
  return collection === 'official' ? kind === 'project' ? '/examples' : '/examples/resources' : kind === 'project' ? '/explore/projects' : '/explore/resources';
}
