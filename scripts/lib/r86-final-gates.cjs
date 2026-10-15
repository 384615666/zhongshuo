/* global module */
/** Every required business outcome is explicit; missing/partial evidence never passes. */
function evaluateR86Final(i){
 const same=b=>!!i.build?.buildId&&b?.buildId===i.build.buildId&&b?.commit===i.build.commit;
 const pair=i.expectedModels??[],checkReal=r=>r?.pass===true&&same(r.build);
 const expectedProofs=[{taskId:i.codeV1?.root?.id,id:i.codeV1?.delivery?.id,revision:1},{taskId:i.codeV1?.root?.id,id:i.lifecycle?.v2?.id,revision:2},{taskId:i.document?.taskId,id:i.document?.delivery?.id,revision:i.document?.delivery?.revision}];
 const validProofs=expectedProofs.every(expected=>expected.taskId&&expected.id&&Number.isSafeInteger(expected.revision)&&i.nativeProofs?.some(p=>checkReal(p)&&p.taskId===expected.taskId&&p.delivery?.id===expected.id&&p.delivery?.revision===expected.revision));

 const checks={
  cleanDistribution:i.build?.dirty===false&&i.distribution?.pass===true&&i.distribution?.pristine===true&&i.distribution?.files===593&&same(i.distribution?.build),
  source:i.source?.pass===true&&i.source?.tests>0&&i.source?.mainTypes===true&&i.source?.hifiTypes===true&&i.source?.lint===true&&i.source?.testedRuntimeCommit===i.build?.commit,
  distinctActualModels:pair.length===2&&new Set(pair).size===2&&checkReal(i.codeV1)&&pair.every(model=>i.codeV1.calls?.some(c=>c.status==='succeeded'&&`${c.runtime_kind}/${c.model}`===model)),
  genuineDependencyFlow:checkReal(i.codeV1)&&i.codeV1.final?.steps?.length>=2&&i.codeV1.final.steps.every(s=>s.status==='DONE')&&i.codeV1.final.steps.some(s=>s.role==='review'&&JSON.parse(s.handoff_json??'{}').upstream?.length>0),
  readablePlanningWindow:checkReal(i.codeV1)&&i.codeV1.planningWindow?.pass===true&&i.codeV1.planningWindow.mainPool===true&&i.codeV1.planningWindow.thread===true&&i.codeV1.planningWindow.whileChildrenUnfinished===true&&i.codeV1.planningWindow.originalProtocolPreserved===true,
  exactNativeExecution:Array.isArray(i.nativeProofs)&&i.nativeProofs.length>=3&&i.nativeProofs.every(checkReal)&&validProofs&&new Set(i.nativeProofs.map(p=>`${p.taskId}:${p.delivery?.id}`)).size===i.nativeProofs.length,
  explicitV2AcceptanceAndReopen:checkReal(i.lifecycle)&&i.lifecycle.noteOnlyNoCalls===true&&i.lifecycle.explicitExecution===true&&i.lifecycle.v2?.revision===2&&i.lifecycle.v2?.reviewStatus==='accepted'&&i.lifecycle.normalClose===true&&i.lifecycle.reopened===true&&i.lifecycle.originalFilesHashMatched===true,
  documentCollaboration:checkReal(i.document)&&i.document.actualPreview===true&&i.document.contributorsVerified===true&&i.document.originalSavedHashMatched===true,
  selectedDeliberation:checkReal(i.deliberation)&&i.deliberation.distinctModels===true&&i.deliberation.independentInputs===true&&i.deliberation.crossReview===true&&i.deliberation.naturalReport===true,
  nativeNavigation:checkReal(i.navigation)&&i.navigation.nativeMouseKeyboard===true&&i.navigation.childTask===true&&i.navigation.exactDelivery===true&&i.navigation.backAndRefresh===true&&i.navigation.rootDraftAndActionsUnchanged===true,
  zeroInferenceRegression:i.full?.pass===true&&i.full?.buildId===i.build?.buildId&&i.full?.finalRealCalls===0&&i.full?.r79?.threeCycles===true&&i.full?.r79?.reopen===true,
  upgradeAndRollback:checkReal(i.upgrade)&&i.upgrade.oldProgramRejection?.databaseUnchanged===true&&i.upgrade.oldProgramRejection?.code==='SCHEMA_VERSION_UNSUPPORTED'&&i.upgrade.draftsAndUploadsComparedToOld===true&&i.upgrade.after?.calls===0,
  inspectedVisualPairs:checkReal(i.visual)&&i.visual.inspected===true&&i.visual.sameViewportThemeDpr===true&&i.visual.wide===true&&i.visual.narrow===true&&i.visual.emulatedHiDpi===true,
  originalFailuresAndCalls:i.ledger?.pass===true&&i.ledger.originalFailuresRetained===true&&i.ledger.allAttemptsCounted===true&&i.ledger.noAutomaticReplay===true,
 };
 return{pass:Object.values(checks).every(x=>x===true),checks,failed:Object.entries(checks).filter(([,v])=>v!==true).map(([k])=>k),userAcceptance:'pending'};
}
module.exports={evaluateR86Final};
