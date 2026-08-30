let pendingResolver = null;
let authorized = false;

function install() {
  if (typeof wx.onNeedPrivacyAuthorization !== "function") throw new Error("PRIVACY_API_UNAVAILABLE");
  wx.onNeedPrivacyAuthorization((resolve, eventInfo) => {
    if (pendingResolver) pendingResolver({ event: "disagree" });
    pendingResolver = resolve;
    authorized = false;
    resolve({ event: "exposureAuthorization" });
    const application = getApp();
    application.globalData.privacyRequest = { referrer: eventInfo && typeof eventInfo.referrer === "string" ? eventInfo.referrer : "private-api" };
    wx.navigateTo({ url: "/pages/privacy/index" });
  });
}

function requireAuthorization() {
  if (typeof wx.requirePrivacyAuthorize !== "function") return Promise.reject(new Error("PRIVACY_API_UNAVAILABLE"));
  return new Promise((resolve, reject) => wx.requirePrivacyAuthorize({
    success: () => { authorized = true; resolve(); },
    fail: () => { authorized = false; reject(new Error("PRIVACY_AUTHORIZATION_DENIED")); },
  }));
}

function decide(agree) {
  if (typeof agree !== "boolean" || pendingResolver === null) throw new Error("PRIVACY_DECISION_NOT_PENDING");
  const resolver = pendingResolver;
  pendingResolver = null;
  authorized = agree;
  getApp().globalData.privacyRequest = null;
  resolver({ event: agree ? "agree" : "disagree" });
}
function clear() {
  if (pendingResolver) pendingResolver({ event: "disagree" });
  pendingResolver = null; authorized = false;
  try { getApp().globalData.privacyRequest = null; } catch {}
}
function isAuthorized() { return authorized; }

module.exports = { install, requireAuthorization, decide, clear, isAuthorized };
