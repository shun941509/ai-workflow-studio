-- Fictional read-only practice data. Creation statements belong to the supplied example, not an operational database.
PRAGMA foreign_keys=ON;
CREATE TABLE projects(project_id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','paused','closed')));
CREATE TABLE roles(role_id TEXT PRIMARY KEY,title TEXT NOT NULL);
CREATE TABLE tasks(task_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(project_id),owner_role_id TEXT REFERENCES roles(role_id),title TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('todo','doing','done')),due_date TEXT);
CREATE TABLE reports(report_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(project_id),title TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','review','approved')));
