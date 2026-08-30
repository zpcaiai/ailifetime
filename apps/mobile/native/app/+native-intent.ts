export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (/^ailtm:\/\/auth\/callback(?:\?[A-Za-z0-9._~!$&'()*+,;=:@/?%-]*)?$/.test(path)) return path;
  if (/^ailtm:\/\/open\/[A-Za-z0-9_-]{32,256}$/.test(path)) return `/account?navigationReference=${encodeURIComponent(path.slice("ailtm://open/".length))}`;
  return "/";
}
