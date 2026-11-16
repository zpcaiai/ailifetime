import {WechatIdentityAuthority} from '../../services/api/src/wechat-identity.ts';
let authority;
let xhsAuthority;
const sharedRoutes = new Set(['/health/live', '/health/ready', '/.well-known/jwks.json']);
export default async function handler(request,response){
 try{
  const path=new URL(request.url??'/','https://identity.invalid').pathname;
  const xhsOnly = Boolean(process.env.LTM_XHS_APP_ID && !process.env.LTM_WECHAT_APP_ID);
  if(path==='/v1/mini-program/sessions' || (xhsOnly && sharedRoutes.has(path))){
   xhsAuthority??=new WechatIdentityAuthority(process.env,undefined,'xhs');
   await xhsAuthority.handle(request,response);
  }else{
   authority??=new WechatIdentityAuthority(process.env);
   await authority.handle(request,response);
  }
 }
 catch{response.statusCode=503;response.setHeader('content-type','application/json; charset=utf-8');response.setHeader('cache-control','private, no-store');response.end(JSON.stringify({error:{code:'IDENTITY_NOT_CONFIGURED'}}));}
}
