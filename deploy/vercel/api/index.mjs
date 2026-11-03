import { createVercelHandler } from '../../../services/api/dist/vercel-handler.js';
const application = createVercelHandler(process.env, process.cwd());
export default application.handler;
