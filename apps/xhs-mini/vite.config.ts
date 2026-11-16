import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';
import path from 'node:path';

function isHttpsOrigin(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 261 &&
    /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) &&
    !/\.(?:localhost|local|test|example|invalid)$/.test(value);
}

function bindMiniProgramProductionConfig(): Plugin {
  let binding: { platform: string; appId: string; apiOrigin: string; identityOrigin?: string } | undefined;
  return {
    name: 'ailifetime-mini-program-production-config',
    apply: 'build',
    configResolved(config) {
      const platform = process.env.UNI_PLATFORM;
      if ((platform !== 'mp-xhs' && platform !== 'mp-weixin') || config.env.VITE_SANDBOX_MODE !== 'false') return;
      const appId = platform === 'mp-xhs' ? config.env.VITE_XHS_MINI_APPID : config.env.VITE_WECHAT_MINI_APPID;
      const validAppId = platform === 'mp-xhs'
        ? /^[A-Za-z0-9]{24}$/.test(appId)
        : /^wx[0-9a-f]{16}$/.test(appId) && appId !== 'wx0000000000000000';
      if (!appId || !validAppId) throw new Error('PRODUCTION_MINI_PROGRAM_APP_ID_REQUIRED');
      const apiOrigin = config.env.VITE_API_BASE_URL;
      if (!isHttpsOrigin(apiOrigin)) throw new Error('PRODUCTION_API_ORIGIN_INVALID');
      if (platform === 'mp-xhs') {
        const identityOrigin = config.env.VITE_XHS_IDENTITY_ORIGIN;
        if (!isHttpsOrigin(identityOrigin)) throw new Error('PRODUCTION_XHS_IDENTITY_ORIGIN_INVALID');
        binding = { platform, appId, apiOrigin, identityOrigin };
        return;
      }
      binding = { platform, appId, apiOrigin };
    },
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        if (!binding) return;
        const projectAsset = bundle['project.config.json'];
        const apiChunk = bundle['services/api.js'];
        if (projectAsset?.type !== 'asset' || typeof projectAsset.source !== 'string' ||
            apiChunk?.type !== 'chunk' || !apiChunk.code.includes(JSON.stringify(binding.apiOrigin)) ||
            (binding.identityOrigin && !apiChunk.code.includes(JSON.stringify(binding.identityOrigin)))) {
          this.error('PRODUCTION_ARTIFACT_BINDING_FAILED');
        }
        const project = JSON.parse(projectAsset.source);
        project.appid = binding.appId;
        projectAsset.source = JSON.stringify(project, null, 2) + '\n';
        this.emitFile({
          type: 'asset',
          fileName: 'release-build.json',
          source: JSON.stringify({
            version: 1,
            ...binding,
            apiSha256: createHash('sha256').update(apiChunk.code).digest('hex'),
          }, null, 2) + '\n',
        });
      },
    },
  };
}

export default defineConfig({
  plugins: [uni(), bindMiniProgramProductionConfig()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@ailifetime/contracts': path.resolve(__dirname, 'src/contracts/index.ts'),
      '@ailifetime/sdk-ts': path.resolve(__dirname, 'src/sdk/index.ts'),
    },
  },
});
