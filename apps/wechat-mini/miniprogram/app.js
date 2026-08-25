const session = require("./services/session");

App({
  globalData: { session: null, policy: null },

  onLaunch() {
    session.clear();
    this.globalData.policy = null;
  },

  onHide() {
    session.clearPrivateUrls();
  },

  onError(error) {
    const name = typeof error === "string" ? error.split(":", 1)[0] : "MiniProgramError";
    console.error(JSON.stringify({ event: "client.error", name }));
  },
});
