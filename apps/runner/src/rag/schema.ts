/** The RAG database is separate from Runner run-state. Complete staged bytes and active pointers have distinct lifetimes. */
export const RAG_DATABASE_VERSION = 1;
export const RAG_APPLICATION_ID = 0x53524147;
export const RAG_TABLES = ['rag_scopes', 'rag_subjects', 'rag_access', 'rag_corpora', 'rag_sources', 'rag_indexes', 'rag_artifacts', 'rag_active'] as const;
export const RAG_MIGRATION = `
CREATE TABLE rag_scopes(tenant TEXT NOT NULL, project TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>=1), PRIMARY KEY(tenant,project)) STRICT;
CREATE TABLE rag_subjects(tenant TEXT NOT NULL, project TEXT NOT NULL, subject TEXT NOT NULL, groups_json TEXT NOT NULL, PRIMARY KEY(tenant,project,subject), FOREIGN KEY(tenant,project) REFERENCES rag_scopes(tenant,project)) STRICT;
CREATE TABLE rag_access(tenant TEXT NOT NULL, project TEXT NOT NULL, document TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), tombstoned INTEGER NOT NULL CHECK(tombstoned IN(0,1)), subjects_json TEXT NOT NULL, groups_json TEXT NOT NULL, PRIMARY KEY(tenant,project,document), FOREIGN KEY(tenant,project) REFERENCES rag_scopes(tenant,project)) STRICT;
CREATE TABLE rag_corpora(tenant TEXT NOT NULL, project TEXT NOT NULL, corpus TEXT NOT NULL, generation TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(tenant,project,corpus,generation), FOREIGN KEY(tenant,project) REFERENCES rag_scopes(tenant,project)) STRICT;
CREATE TABLE rag_sources(tenant TEXT NOT NULL, project TEXT NOT NULL, corpus TEXT NOT NULL, generation TEXT NOT NULL, document TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), original_hash TEXT NOT NULL, text_hash TEXT NOT NULL, extraction_hash TEXT NOT NULL, source_uri TEXT NOT NULL, original BLOB NOT NULL, extracted BLOB NOT NULL, extraction TEXT NOT NULL, PRIMARY KEY(tenant,project,corpus,generation,document), FOREIGN KEY(tenant,project,corpus,generation) REFERENCES rag_corpora(tenant,project,corpus,generation)) STRICT;
CREATE INDEX rag_source_identity ON rag_sources(tenant,project,document,revision);
CREATE TABLE rag_indexes(tenant TEXT NOT NULL, project TEXT NOT NULL, index_id TEXT NOT NULL, generation TEXT NOT NULL, hash TEXT NOT NULL, corpus TEXT NOT NULL, corpus_generation TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(tenant,project,index_id,generation), FOREIGN KEY(tenant,project,corpus,corpus_generation) REFERENCES rag_corpora(tenant,project,corpus,generation)) STRICT;
CREATE TABLE rag_artifacts(tenant TEXT NOT NULL, project TEXT NOT NULL, index_id TEXT NOT NULL, generation TEXT NOT NULL, artifact TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(tenant,project,index_id,generation,artifact), FOREIGN KEY(tenant,project,index_id,generation) REFERENCES rag_indexes(tenant,project,index_id,generation)) STRICT;
CREATE TABLE rag_active(tenant TEXT NOT NULL, project TEXT NOT NULL, index_id TEXT NOT NULL, generation TEXT NOT NULL, hash TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), PRIMARY KEY(tenant,project,index_id), FOREIGN KEY(tenant,project,index_id,generation) REFERENCES rag_indexes(tenant,project,index_id,generation)) STRICT;
${['rag_corpora', 'rag_sources', 'rag_indexes', 'rag_artifacts'].flatMap(table => ['UPDATE', 'DELETE'].map(operation => `CREATE TRIGGER ${table}_${operation.toLowerCase()}_immutable BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'RAG_IMMUTABLE_GENERATION'); END;`)).join('\n')}
PRAGMA application_id=${RAG_APPLICATION_ID};
PRAGMA user_version=${RAG_DATABASE_VERSION};
`;
