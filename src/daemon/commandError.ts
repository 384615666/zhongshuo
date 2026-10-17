export class DaemonCommandError extends Error {
  readonly code:string;
  readonly operationPending:boolean;
  readonly operationKnownRejected:boolean;
  constructor(code:string,message:string,operationPending=false,operationKnownRejected=false){
    super(message);this.name='DaemonCommandError';this.code=code;
    this.operationPending=operationPending;this.operationKnownRejected=operationKnownRejected;
  }
}
