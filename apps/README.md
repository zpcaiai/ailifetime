# Application surfaces

`web` is the runnable browser surface. It exposes seven role-aware portals that cover all 22 skill workspaces and the complete B00-B127 catalog through one shared shell.

`mobile` and `wechat-mini` are framework-neutral production security cores for native shells. They enforce offline-command allowlists, bounded payloads, deep-link policy, capture preflight, server-authoritative store entitlements, WeChat payment projections, opaque share grants and one-use service-message authorization. They are intentionally shared rather than cloning these trust rules into separate screens.

They are not signed iOS, Android or WeChat release artifacts. A production release must embed these cores in the selected native/Taro shells, run platform/device tests, produce signed builds and retain the Apple, Google and WeChat review decisions required by the B127 manifest.
