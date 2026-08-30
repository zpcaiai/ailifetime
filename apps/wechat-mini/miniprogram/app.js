const session = require("./services/session");
const commerce = require("./services/commerce");
const privacy = require("./services/privacy");

App({
  globalData: { session: null, policy: null, privacyRequest: null },

  onLaunch() {
    session.clear();
    commerce.clear();
    privacy.install();
    this.globalData.policy = null;
  },

  onHide() {
    session.clearPrivateUrls();
    commerce.clear();
    privacy.clear();
  },

  onError(error) {
    const name = typeof error === "string" ? error.split(":", 1)[0] : "MiniProgramError";
    console.error(JSON.stringify({ event: "client.error", name }));
  },
});
