const api = require("../../services/api");
const session = require("../../services/session");

Page({
  data: {enabled:false,connected:false,busy:false,error:"",expiresAt:""},
  credential: "", active:true, epoch:0,
  onLoad() {
    const ext=wx.getExtConfigSync ? wx.getExtConfigSync() : {};
    const development=wx.getAccountInfoSync().miniProgram.envVersion === "develop";
    try {
      if (!development || ext.nativeAlbumTestEnabled !== true) throw Error("联调入口只允许显式开启的开发预览。");
      const base=api.configuration().baseUrl;
      const https=/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(base) && !/\.(?:invalid|example|test)$/.test(base);
      const local=wx.getSystemInfoSync().platform === "devtools" && /^http:\/\/127\.0\.0\.1:\d+$/.test(base);
      if (!https && !local) throw Error("手机联调必须使用已登记的实际 HTTPS 服务。");
      this.setData({enabled:true,error:""});
    } catch(error) {this.setData({enabled:false,error:error.message || "联调配置无效。"});}
  },
  onShow() {this.active=true;},
  onHide() {this.active=false;this.epoch++;this.credential="";this.setData({busy:false});},
  onUnload() {this.onHide();},
  tokenChanged(event) {this.credential=String(event.detail.value || "").trim();},
  async connect() {
    if (!this.data.enabled || this.data.busy || !this.active) return;
    const token=this.credential;
    if (!/^[a-f0-9]{64}$/.test(token)) {this.setData({error:"请输入部署负责人提供的短期测试凭据。"});return;}
    const epoch=++this.epoch,current=()=>this.active && epoch===this.epoch;
    const clearOwn=()=>{if(session.get()?.accessToken===token)session.clear();};
    this.setData({busy:true,connected:false,error:""});
    try {
      // This is an explicit sandbox principal, never a replacement wx.login
      // result. Every candidate is checked by the real backend before use.
      let candidate={accessToken:token,expiresAt:new Date(Date.now()+30*60*1000).toISOString(),actorId:"user",tenantId:"tenant",roles:["consumer"],purpose:"age_transformation"};
      session.set(candidate);
      const config=await api.request("/native-album/config",{method:"GET"});
      if (!current()) {clearOwn();return;}
      if (config.fixtureKind!=="synthetic-album-transport-only" || config.commands?.single!=="single-root" || config.commands?.batch!=="root" || Date.parse(config.expiresAt)<=Date.now()+30000) throw Error("测试服务配置无效或即将过期。");
      candidate={...candidate,expiresAt:config.expiresAt};session.set(candidate);
      const projection=await api.request("/v1/session",{method:"GET"});
      if (!current()) {clearOwn();return;}
      session.bindServerProjection(candidate,projection);
      this.credential="";
      this.setData({connected:true,expiresAt:config.expiresAt,error:""});
    } catch(error) {clearOwn();if(current())this.setData({connected:false,error:"测试身份校验失败，请检查服务、凭据及有效期。"});}
    finally {if(current())this.setData({busy:false});}
  },
  openSingle() {this.open("single-root");},
  openBatch() {this.open("root");},
  open(commandId) {
    if (!this.data.enabled || !this.data.connected || !session.get()) {this.setData({connected:false,error:"请先校验尚未过期的测试身份。"});return;}
    wx.navigateTo({url:`/pages/job/index?commandId=${commandId}`});
  },
});
