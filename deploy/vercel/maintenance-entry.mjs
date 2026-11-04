import baseline from '@ltm-deployment-baseline';
import {createVercelHandler} from '../../services/api/dist/vercel-handler.js';

const maintenance=createVercelHandler(process.env,process.cwd());
// Preserve the verified deployed business code while advancing only maintenance.
export default function handler(request,response){
 const path=new URL(request.url??'/','https://function.invalid').pathname;
 return path==='/internal/media-cleanup'?maintenance.handler(request,response):baseline(request,response);
}
