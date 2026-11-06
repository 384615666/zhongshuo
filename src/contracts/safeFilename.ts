/** Portable output filename; the display name remains unchanged. */
export function safeFilename(value:string):string {
  const original=value;
  // eslint-disable-next-line no-control-regex -- intentionally matching invisible/control code points
  let name=value.replace(/[\x00-\x1f\x7f]/g,'').replace(/[<>:"/\\|?*]/g,'_').replace(/[. ]+$/g,'').trim();
  if(!name||name==='.'||name==='..')name='file';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name=`_${name}`;
  const encoder=new TextEncoder();
  if(encoder.encode(name).length>180){
    let hash=2166136261;
    for(const char of original)hash=Math.imul(hash^char.codePointAt(0)!,16777619);
    const ext=/\.[a-z0-9]{1,12}$/i.exec(name)?.[0]??'';
    let stem='';
    for(const char of ext?name.slice(0,-ext.length):name){if(encoder.encode(stem+char).length>145)break;stem+=char;}
    name=`${stem}-${(hash>>>0).toString(16)}${ext}`;
  }
  return name;
}
