// Attach the stored résumé file to a page's <input type=file>.
//
// The file input on most ATS forms (Greenhouse/Lever) is display:none, so it is
// absent from the accessibility tree and cannot be targeted by ARIA index like
// the other actions. And chrome.debugger's DOM.setFileInputFiles is blocked for
// extensions ("Not allowed"). So we inject in-page: rebuild a File from the
// stored bytes, assign input.files via a DataTransfer, and fire input + change —
// the approach real automation uses when it only has bytes, not a file path.
//
// This module holds the pure pieces (in-page function strings + CDP param
// builders); the tool dispatch that wires them through CDP is appended in the
// next step alongside its imports.

// Runs IN THE PAGE. Returns the file input to use: the one whose label/name/aria
// matches `label` if given, else the résumé/cv one, else the first. null if none.
export const LOCATE_FN = `function(label){
  var inputs = Array.prototype.slice.call(document.querySelectorAll('input[type=file]'));
  if(!inputs.length){ return null; }
  function text(el){
    var t='';
    if(el.id){ var l=document.querySelector('label[for="'+el.id+'"]'); if(l){ t+=' '+l.textContent; } }
    var p=el.closest('label'); if(p){ t+=' '+p.textContent; }
    t+=' '+(el.name||'')+' '+(el.getAttribute('aria-label')||'');
    return t.toLowerCase();
  }
  var want=(label||'').toLowerCase();
  if(want){ for(var i=0;i<inputs.length;i++){ if(text(inputs[i]).indexOf(want)>=0){ return inputs[i]; } } }
  for(var j=0;j<inputs.length;j++){ var s=text(inputs[j]); if(s.indexOf('resume')>=0||s.indexOf('cv')>=0){ return inputs[j]; } }
  return inputs[0];
}`;

// Runs IN THE PAGE bound to the located input (this). Rebuilds the File from
// base64 and attaches it via DataTransfer, then fires input + change.
export const INJECT_FN = `function(b64, name, mime){
  var bin=atob(b64); var len=bin.length; var bytes=new Uint8Array(len);
  for(var i=0;i<len;i++){ bytes[i]=bin.charCodeAt(i); }
  var file=new File([bytes], name, { type: mime });
  var dt=new DataTransfer(); dt.items.add(file);
  this.files=dt.files;
  this.dispatchEvent(new Event('input', { bubbles:true, composed:true }));
  this.dispatchEvent(new Event('change', { bubbles:true, composed:true }));
  return { name:(this.name||''), accept:(this.getAttribute('accept')||''), fileName:(this.files[0]?this.files[0].name:''), count:this.files.length };
}`;

export function buildLocateExpression(labelContains?: string): string {
  return `(${LOCATE_FN})(${JSON.stringify(labelContains ?? '')})`;
}

export interface InjectParams {
  objectId: string;
  functionDeclaration: string;
  arguments: Array<{ value: string }>;
  returnByValue: boolean;
}

export function buildInjectParams(
  objectId: string,
  resume: { base64: string; name: string; mime: string },
): InjectParams {
  return {
    objectId,
    functionDeclaration: INJECT_FN,
    arguments: [{ value: resume.base64 }, { value: resume.name }, { value: resume.mime }],
    returnByValue: true,
  };
}
