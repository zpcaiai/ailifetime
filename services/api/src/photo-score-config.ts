import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DomainError } from "@ltm/core";
import { HttpPhotoScorer } from "./photo-score-client.js";
import { validatePhotoPolicy, type PhotoPolicy } from "./photo-score-contract.js";

function invalid():never { throw new DomainError("CONFIGURATION_INVALID","photo scoring requires explicit URL, safe token/policy files, calibrated policies and channel"); }
function file(path:string,secret:boolean):void {
  if(!isAbsolute(path))return invalid();
  try {
    const stat=lstatSync(path);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size<1 || stat.size>(secret?8192:512*1024) || (stat.mode & (secret?0o077:0o022))!==0) return invalid();
  }catch{return invalid();}
}
export function configuredPhotoScoring(environment:Readonly<Record<string,string|undefined>>,appEnvironment:string):{scorer:HttpPhotoScorer;policies:PhotoPolicy[];channel:string}|undefined {
  const names=["URL","TOKEN_FILE","POLICY_FILE","CHANNEL","TIMEOUT_MS","ALLOW_HTTP_LOOPBACK"];
  if(names.every(key=>environment["LTM_PHOTO_SCORER_"+key]===undefined))return undefined;
  const url=environment.LTM_PHOTO_SCORER_URL,token=environment.LTM_PHOTO_SCORER_TOKEN_FILE,path=environment.LTM_PHOTO_SCORER_POLICY_FILE,channel=environment.LTM_PHOTO_SCORER_CHANNEL;
  if(!url || !token || !path || !channel || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(channel))return invalid();
  const allow=environment.LTM_PHOTO_SCORER_ALLOW_HTTP_LOOPBACK;
  if(allow!==undefined && allow!=="true" && allow!=="false")return invalid();
  if(allow==="true" && !["local","test"].includes(appEnvironment))return invalid();
  file(token,true);file(path,false);
  let policies:PhotoPolicy[];
  try {
    const value:unknown=JSON.parse(readFileSync(path,"utf8"));
    if(!Array.isArray(value) || value.length<1 || value.length>128)return invalid();
    policies=value.map(value=>validatePhotoPolicy(value as PhotoPolicy));
    if(new Set(policies.map(p=>p.id)).size!==policies.length || policies.some(p=>p.context.channel!==channel))return invalid();
  }catch{return invalid();}
  const timeout=environment.LTM_PHOTO_SCORER_TIMEOUT_MS;
  if(timeout!==undefined && !/^\d+$/.test(timeout))return invalid();
  const scorer=new HttpPhotoScorer({baseUrl:url,workloadTokenFile:token,allowInsecureLoopback:allow==="true",...(timeout===undefined?{}:{timeoutMs:Number(timeout)})});
  return {scorer,policies,channel};
}
