import {WechatIdentityAuthority} from '../../services/api/src/wechat-identity.ts';
let authority;
export default async function handler(request,response){
 try{authority??=new WechatIdentityAuthority(process.env);await authority.handle(request,response);}
 catch{response.statusCode=503;response.setHeader('content-type','application/json; charset=utf-8');response.setHeader('cache-control','private, no-store');response.end(JSON.stringify({error:{code:'IDENTITY_NOT_CONFIGURED'}}));}
}
