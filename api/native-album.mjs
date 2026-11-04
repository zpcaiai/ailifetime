import { createNativeAlbumServerless } from '../tools/native-album-serverless.mjs';

export function createNativeAlbumNodeEntry(options) {
  const app = createNativeAlbumServerless(options);
  return {
    async handler(req, res) {
      const controller = new AbortController();
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      try {
        const request = new Request(new URL(req.url, 'https://native-album-test.invalid'), {
          method:req.method, headers:req.headers, signal:controller.signal,
        });
        const response = await app.handle(request);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!res.destroyed) { res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(bytes); }
      } catch {
        console.error('Native album test request unavailable');
        if (!res.destroyed) { res.writeHead(503, {'cache-control':'no-store'}); res.end(); }
      }
    },
    close:() => app.close(),
  };
}

let deployed;
const deploymentHandler = async (req, res) => {
  try {
    deployed ||= createNativeAlbumNodeEntry({tokenSha256:process.env.LTM_NATIVE_ALBUM_TOKEN_SHA256, expiresAt:process.env.LTM_NATIVE_ALBUM_EXPIRES_AT});
    await deployed.handler(req, res);
  } catch {
    console.error('Native album test deployment configuration unavailable');
    if (!res.destroyed) { res.writeHead(503, {'cache-control':'no-store'}); res.end(); }
  }
};
export default deploymentHandler;
