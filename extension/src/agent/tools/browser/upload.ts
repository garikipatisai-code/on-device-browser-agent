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
// builders) and the tab.upload_file tool that wires them through CDP.

import { z } from 'zod';
import type { ToolDefDescriptor } from '../registry';
import { withCdp } from './lifecycle';
import { assertCanAct } from '@/agent/safety/domain_tiers';
import { clearExtractionCache } from './aria_tool';
import { loadResumeFile } from '@/background/state_store';

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

async function tabUrl(tabId: number): Promise<string> {
  return new Promise((resolve) => chrome.tabs.get(tabId, (t) => resolve(t?.url ?? '')));
}

export const tabUploadFileTool: ToolDefDescriptor<{ tabId: number; labelContains?: string }> = {
  name: 'tab.upload_file',
  description:
    "Attach the user's stored résumé to a file-upload field. The file input is usually hidden (display:none) and has NO ARIA index — call this with just tabId (optionally labelContains to choose among several upload fields). Do NOT use tab.click for file uploads. Requires click-only tier.",
  argsSchema: z.object({
    tabId: z.number().int(),
    labelContains: z.string().optional(),
  }),
  async dispatch({ tabId, labelContains }, ctx) {
    const url = await tabUrl(tabId);
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers);
    const resume = await loadResumeFile();
    if (!resume) {
      return { ok: false, content: 'No résumé stored. Upload one in Settings → Profile first.' };
    }
    const data = await withCdp(tabId, async (send) => {
      const located = await send<{ result?: { objectId?: string; subtype?: string } }>('Runtime.evaluate', {
        expression: buildLocateExpression(labelContains),
        returnByValue: false,
      });
      const objectId = located.result?.objectId;
      if (!objectId || located.result?.subtype === 'null') return null;
      const injected = await send<{ result?: { value?: Record<string, unknown> } }>(
        'Runtime.callFunctionOn',
        buildInjectParams(objectId, resume) as unknown as Record<string, unknown>,
      );
      return injected.result?.value ?? {};
    });
    clearExtractionCache(tabId);
    if (data === null) {
      return {
        ok: false,
        content: 'No <input type=file> found on this page (it may be inside an iframe, which is unsupported in v1).',
      };
    }
    return { ok: true, content: `Attached résumé "${resume.name}" to the upload field.`, data: data as Record<string, unknown> };
  },
};
