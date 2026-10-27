"use client";
import dynamic from "next/dynamic";

/** The canvas is loaded only in authoring views, keeping account/library pages lightweight. */
const Editor = dynamic(() => import("./WorkflowEditor").then((module) => module.WorkflowEditor), { ssr: false, loading: () => <div className="loading-panel">편집기를 준비하고 있습니다…</div> });
export function EditorLoader(props: { draftId?: string; projectId?: string; cloudConfigured: boolean }) { return <Editor {...props}/>; }
