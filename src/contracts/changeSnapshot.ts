export interface ChangeSnapshot {
  projectId:string;taskId:string;changeSetId:string;applicationStatus:string;
  files:Array<{path:string;change:'added'|'removed'|'modified'|'unknown';beforeHash:string|null;afterHash:string|null}>;
  truncated:boolean;
  content?:{path:string;before:{text:string|null;reason:string|null};after:{text:string|null;reason:string|null}};
}
