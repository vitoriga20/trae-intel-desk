"use strict";
/* ============================================================
   TRAE 情报台 · 应用脚本
   ============================================================ */

/* ---------- 配置 ---------- */
const CFG = {
  base: "https://forum.trae.cn",
  // 抓取通道（纯前端方案，按优先级依次尝试）
  // 1) 自定义代理：自建 Cloudflare Worker（数据管理页可填）
  // 2) corsfix 公共代理：sdk=1 走免注册免费档，任何公网域名可用（实测 GitHub Pages 下 200）
  // 3) corsproxy.io：需 API Key
  // 4) allorigins：公共兜底，常超时
  customProxy: "",
  proxyUrlStore: "trae_intel_proxyurl",
  proxyKey: "",
  corsfixProxy: "https://proxy.corsfix.com/?sdk=1&url=",
  proxyKeyStore: "trae_intel_proxykey",
  // 请求频率（每请求间隔 + 正文并发），默认低频；corsfix 实测间隔 1 秒较稳
  freqStore: "trae_intel_freq",
  freqDefault: "low",
  freqLevels: {
    low:    {label:"低频（默认）", interval:1200, concurrency:1},
    medium: {label:"中频",         interval:600,  concurrency:2},
    high:   {label:"高频",         interval:200,  concurrency:3}
  },
  // 官方账号（识别官方内容）；识别不全会漏标，多了会误标，可在下方追加
  officialUsers: ["TRAE-小阳","TRAE宝","TRAE_小菠","TRAE_小晨儿","TRAE_小橙","TRAE技术支持-麻辣鸡腿堡","TRAE官方"],
  // 板块表：活动源（进时间线/日历，全量抓 + 拉正文提取活动时间）——暂只从福利活动提取
  actCats: [
    {id:29, name:"福利活动", path:"/c/29-category/29.json"}
  ],
  // 信息流板块（最新 N 页，不拉正文）
  feedCats: [
    {id:6,  name:"官方活动", path:"/c/6-category/6.json"},
    {id:32, name:"共学直播", path:"/c/6-category/32-category/32.json"},
    {id:4,  name:"官方公告", path:"/c/4-category/4.json"},
    {id:38, name:"大赛专区", path:"/c/38-category/38.json"},
    {id:42, name:"大赛复赛", path:"/c/38-category/42-category/42.json"},
    {id:9,  name:"技巧分享", path:"/c/9-category/9.json"},
    {id:10, name:"案例与作品", path:"/c/10-category/10.json"},
    {id:43, name:"TraeWork 专区", path:"/c/43-category/43.json"}
  ],
  feedPages: 1,
  actPages: 1,
  kindRules: {
    actKeywords: ["大赛","比赛","挑战赛","活动","报名","征集","直播","训练营","共创","评选","评选开启","开奖","共学"],
    noticeCats: [4],
    welfareCats: [29],
    activityCats: [6,32,38,42]
  },
  storeKey: "trae_intel_v1"
};

/* ---------- 工具 ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s==null?"":s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function relTime(iso){
  if(!iso) return "-";
  const t = new Date(iso).getTime(), d = Date.now() - t, m = 60*1000, h = 60*m, day = 24*h;
  if(d < m) return "刚刚";
  if(d < h) return Math.floor(d/m)+" 分钟前";
  if(d < day) return Math.floor(d/h)+" 小时前";
  if(d < 7*day) return Math.floor(d/day)+" 天前";
  return fmtDate(iso);
}
function fmtDate(iso){
  if(!iso) return "-";
  const d = new Date(iso);
  const p = n => String(n).padStart(2,"0");
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());
}
function fmtDT(iso){
  if(!iso) return "-";
  const d = new Date(iso);
  const p = n => String(n).padStart(2,"0");
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes());
}
function countdown(iso){
  const t = new Date(iso).getTime() - Date.now();
  if(t <= 0) return {txt:"已到期", cls:"late"};
  const day = 24*3600*1000, d = t/day;
  if(d > 7) return {txt:Math.floor(d)+" 天后", cls:""};
  if(d > 3) return {txt:Math.floor(d)+" 天后", cls:"warn"};
  if(d > 1) return {txt:Math.floor(d)+" 天后", cls:"late"};
  const h = Math.floor(t/3600/1000), m = Math.floor((t-h*3600*1000)/60000);
  return {txt:(h?h+" 小时 ":"")+m+" 分", cls:"late"};
}
function actStatus(a){
  const now = Date.now();
  if(!a) return null;
  // 无明确时间 → 视为长期进行中（福利/滚动活动）
  if(!a.start && !a.end && !a.deadline) return "running";
  const end = a.end||a.deadline, start = a.start||a.end||a.deadline;
  if(end && now > new Date(end).getTime()) return "ended";
  if(start && now < new Date(start).getTime()) return "upcoming";
  return "running";
}
// 活动源：论坛仅福利活动板块 + 非论坛来源（手动/飞书）；其他板块暂不作为活动
function isActiveSource(i){
  return i.source !== "forum" || i.catId === 29;
}
// 标题带「已结束/已开奖/获奖公示」等标记的，视为已完结，一律不展示/不收录
function isEndedTitle(t){
  return /已结束|已开奖|开奖啦|已过期|已截止|获奖公示|获奖名单|开奖公示|中奖名单|名单公布|获奖结果|开奖结果|名单出炉/.test(t||"");
}
// 正文揭示已开奖（标题可能没有标记，但正文开头写了「已经开奖/公示名单」）
function isEndedText(t){
  return /已经开奖|已开奖|开奖公示|获奖名单|中奖名单|获奖公示|下面公示|名单公布|获奖结果|开奖啦/.test(t||"");
}
// 从 url 提取论坛话题 id，统一 id 体系（t-N），保证种子数据与抓取数据能正确去重
function topicIdFromUrl(url){
  const m = (url||"").match(/\/t\/topic\/(\d+)/);
  return m ? "t-"+m[1] : null;
}
function toast(msg, type){
  const el = document.createElement("div");
  el.className = "toast"+(type?" "+type:"");
  el.textContent = msg;
  $("#toast").appendChild(el);
  setTimeout(()=>{el.style.opacity="0";el.style.transition="opacity .3s";setTimeout(()=>el.remove(),320);}, 2600);
}

/* ---------- 存储层 ---------- */
const Store = {
  data: null,
  load(){
    try{
      const raw = localStorage.getItem(CFG.storeKey);
      this.data = raw ? JSON.parse(raw) : {version:1, items:[], log:[], lastFetch:null};
      if(!this.data.items) this.data.items = [];
      if(!this.data.log) this.data.log = [];
    }catch(e){ this.data = {version:1, items:[], log:[], lastFetch:null}; }
  },
  save(){ try{ localStorage.setItem(CFG.storeKey, JSON.stringify(this.data)); }catch(e){ toast("存储空间不足，建议导出备份后清理数据","err"); } },
  items(){ return this.data.items; },
  byId(id){ return this.data.items.find(i => i.id === id); },
  upsert(item){
    const i = this.data.items.findIndex(x => x.id === item.id);
    if(i >= 0){ this.data.items[i] = Object.assign({}, this.data.items[i], item); return this.data.items[i]; }
    this.data.items.push(item); return item;
  },
  remove(id){ this.data.items = this.data.items.filter(x => x.id !== id); },
  logPush(entry){ this.data.log.unshift(entry); if(this.data.log.length > 100) this.data.log.length = 100; }
};

/* ---------- 派生判定 ---------- */
// 官方账号：用户名以 TRAE 开头（TRAE-小阳 / TRAE宝 / TRAE_小菠 …），不再按板块兜底，
// 避免大赛专区等官方板块里的用户帖被误判为官方
function isOfficial(item){
  if(item.flags && item.flags.is_official !== undefined) return item.flags.is_official;
  const name = item.author || "";
  if(/^TRAE/i.test(name)) return true;
  return CFG.officialUsers.some(u => name.includes(u));
}
// 官方活动板块：官方活动 / 共学直播 / 福利活动 / 大赛专区
function isActBoard(catId){
  return CFG.kindRules.activityCats.concat(CFG.kindRules.welfareCats).includes(catId);
}
function guessKind(item){
  const off = isOfficial(item);
  const t = (item.title||"") + " " + (item.excerpt||"");
  // 官方账号 + 官方活动板块 → 官方活动
  if(off && isActBoard(item.catId)) return "activity";
  if(off && CFG.kindRules.noticeCats.includes(item.catId)) return "notice";
  // 非官方在福利板块：算福利内容（信息流展示，不进活动时间线）
  if(CFG.kindRules.welfareCats.includes(item.catId)) return "welfare";
  if(/教程|技巧|干货|分享|实战|心得|作品|案例/.test(t)) return "share";
  if(/求助|报错|问题|bug|如何|怎么办/.test(t)) return "help";
  return "other";
}

/* ---------- 种子数据（真实公开信息，2026-08） ---------- */
function seedItems(){
  const now = Date.now(), iso = s => new Date(s).toISOString();
  const items = [
    {id:"seed-1", source:"forum", catId:38, category:"大赛专区", title:"TRAE AI 创造力大赛 2026", kind:"activity",
     excerpt:"面向全民的 AI 创新实践赛事。报名/初赛（6.16–7.15，仅个人），复赛（7.21–8.9，可组队，社区发帖+飞书问卷双轨提交），决赛线下路演。4 个通用赛道 + 附加赛题。",
     author:"TRAE-小阳", created:iso("2026-06-10T00:00:00+08:00"), active:iso("2026-08-11T00:00:00+08:00"),
     stats:{posts:221,replies:173,views:16268,likes:56},
     url:"https://forum.trae.cn/c/38-category/38",
     feishuLinks:["https://www.trae.cn/ai-creativity"],
     activity:{start:"2026-06-16T00:00:00+08:00", end:"2026-08-22T23:59:00+08:00",
       requirement:"报名：大赛专区发「创意提案」帖+赛道标签；初赛提交 Demo；复赛打磨完整作品并双轨提交；决赛线下路演。全程使用 TRAE Work / TRAE IDE。",
       signup_url:"https://forum.trae.cn/t/topic/22548"},
     flags:{official:true, is_activity:true}},

    {id:"seed-2", source:"forum", catId:29, category:"福利活动", title:"【评论送 500 份美丽周边】TRAE Work 官方知识库上线，分享学习心得赢周边", kind:"activity",
     excerpt:"TRAE Work 官方知识库上线，在论坛分享学习心得即有机会赢官方周边（共 500 份）。",
     author:"TRAE-小阳", created:iso("2026-07-10T00:00:00+08:00"), active:iso("2026-08-13T00:00:00+08:00"),
     stats:{posts:30,replies:18,views:2300,likes:40},
     url:"https://forum.trae.cn/t/topic/152274",
     feishuLinks:[],
     activity:{start:"2026-07-10T00:00:00+08:00", end:"2026-08-31T23:59:00+08:00",
       requirement:"在对应帖子下分享使用 TRAE Work 知识库的学习心得，优质评论获奖。",
       signup_url:"https://forum.trae.cn/t/topic/152274"},
     flags:{official:true, is_activity:true}},

    {id:"seed-3", source:"forum", catId:43, category:"TraeWork 专区", title:"🎉【有奖征集·积分送不停】#TraeWork的1000种用法 · 由你来定义", kind:"activity",
     excerpt:"TraeWork 的边界由每一位真实 Trae 友定义。上一期《100 种用法》之后的新一期征集：说出你亲测好用的那一招，赢积分。",
     author:"TRAE-小阳", created:iso("2026-08-13T08:12:00+08:00"), active:iso("2026-08-25T09:46:00+08:00"),
     stats:{posts:43,replies:4,views:1898,likes:54},
     url:"https://forum.trae.cn/t/topic/175835",
     feishuLinks:[],
     activity:{start:"2026-08-13T08:00:00+08:00", end:"2026-09-10T23:59:00+08:00",
       requirement:"在征集帖下回复你实测好用的 TraeWork 用法，标注 #TraeWork的1000种用法 标签。",
       signup_url:"https://forum.trae.cn/t/topic/175835"},
     flags:{official:true, is_activity:true}},

    {id:"seed-4", source:"forum", catId:29, category:"福利活动", title:"TRAE 社区贡献者每周评选（每周开启）", kind:"activity",
     excerpt:"分享、互动、助人赢好礼。每周评选社区贡献者。",
     author:"TRAE-小阳", created:iso("2026-07-01T00:00:00+08:00"), active:iso("2026-08-20T00:00:00+08:00"),
     stats:{posts:20,replies:60,views:4200,likes:80},
     url:"https://forum.trae.cn/t/topic/2279",
     feishuLinks:[],
     activity:{start:"2026-07-01T00:00:00+08:00", end:"2026-12-31T23:59:00+08:00",
       requirement:"通过分享优质内容、互动回答、帮助他人积累贡献值，每周评选。",
       signup_url:"https://forum.trae.cn/t/topic/2279"},
     flags:{official:true, is_activity:true}},

    {id:"seed-5", source:"forum", catId:32, category:"共学直播", title:"总结&回放｜TRAE Community Live NO.14", kind:"activity",
     excerpt:"邀请火山引擎企业合作与解决方案专家小珙，分享「从构想到落地：如何借助 TRAE 完成复杂任务」。直播回放：飞书妙记。",
     author:"TRAE-小阳", created:iso("2026-06-26T03:03:00+08:00"), active:iso("2026-06-26T03:03:00+08:00"),
     stats:{posts:1,replies:0,views:86,likes:0},
     url:"https://forum.trae.cn/t/topic/46076",
     feishuLinks:["https://bytedance.larkoffice.com/minutes/obcndj43k211438774c14885"],
     activity:{start:"2026-06-26T03:03:00+08:00", end:"2026-06-26T03:03:00+08:00",
       requirement:"回放链接见飞书妙记，可随时观看学习。",
       signup_url:"https://forum.trae.cn/t/topic/46076"},
     flags:{official:true, is_activity:true}},

    {id:"seed-6", source:"feishu", catId:0, category:"飞书社群", title:"TRAE Work 知识库学习周 · 打卡有礼（社群活动）", kind:"welfare",
     excerpt:"TRAE 社群（飞书）活动：知识库学习周打卡，坚持打卡赢好礼。",
     author:"TRAE 官方", created:iso("2026-07-15T00:00:00+08:00"), active:iso("2026-07-25T00:00:00+08:00"),
     stats:{posts:0,replies:0,views:0,likes:0},
     url:"https://applink.feishu.cn/client/message/link/open?token=AmjCmyEUDgABaliDVZ4ATNc%3D",
     feishuLinks:["https://applink.feishu.cn/client/message/link/open?token=AmjCmyEUDgABaliDVZ4ATNc%3D"],
     activity:{start:"2026-07-15T00:00:00+08:00", end:"2026-07-31T23:59:00+08:00",
       requirement:"在 TRAE 飞书社群完成知识库学习打卡，连续打卡领取奖励。",
       signup_url:"https://applink.feishu.cn/client/message/link/open?token=AmjCmyEUDgABaliDVZ4ATNc%3D"},
     flags:{official:true, is_activity:true}},

    {id:"seed-7", source:"forum", catId:9, category:"技巧分享", title:"让 AI 主导整个开发流程：TraeWork Code 模式的实战工作流拆解", kind:"share",
     excerpt:"把 TraeWork Code 模式用成完整开发工作流的实战拆解：从需求拆解到代码落地。",
     author:"社区伙伴", created:iso("2026-08-21T00:00:00+08:00"), active:iso("2026-08-21T00:00:00+08:00"),
     stats:{posts:1,replies:0,views:20,likes:2},
     url:"https://forum.trae.cn/t/topic/177191",
     feishuLinks:[],
     flags:{official:false, is_activity:false}},

    {id:"seed-8", source:"forum", catId:10, category:"案例与作品", title:"我用 TraeWork 从零做出带模拟支付的英语四级打卡网站", kind:"share",
     excerpt:"准大二学生独立完成全栈产品 + 云部署：需求→设计→开发→上线的完整记录。",
     author:"社区伙伴", created:iso("2026-08-24T00:00:00+08:00"), active:iso("2026-08-24T00:00:00+08:00"),
     stats:{posts:1,replies:0,views:4,likes:1},
     url:"https://forum.trae.cn/t/topic/177678",
     feishuLinks:[],
     flags:{official:false, is_activity:false}},

    {id:"seed-9", source:"forum", catId:4, category:"官方公告", title:"📢 社区公告｜欢迎来到 TRAE 官方中文社区！", kind:"notice",
     excerpt:"这里是属于中国开发者与 AI Coding 爱好者的阵地。社区导航：如何高效玩转这里。",
     author:"TRAE宝", created:iso("2026-02-04T08:41:00+08:00"), active:iso("2026-08-24T00:00:00+08:00"),
     stats:{posts:361,replies:200,views:13119,likes:90},
     url:"https://forum.trae.cn/t/topic/5",
     feishuLinks:[],
     flags:{official:true, is_activity:false}}
  ];
  const out = [];
  for(const it of items){
    // 论坛来源且 url 指向具体话题 → 用 t-N 作为 id，与抓取数据统一去重
    const tid = topicIdFromUrl(it.url);
    const m = {id: tid || String(it.id), source:it.source, kind:it.kind, catId:it.catId, category:it.category,
      title:it.title, excerpt:it.excerpt, content:null, tags:it.tags||[], author:it.author, avatar:null,
      created:it.created, active:it.active, stats:it.stats||{posts:0,replies:0,views:0,likes:0},
      image:null, url:it.url, feishuLinks:it.feishuLinks||[], activity:it.activity||null,
      flags:{official:!!it.flags.official, is_activity:!!it.flags.is_activity, starred:false}};
    out.push(m);
  }
  return out;
}

/* ---------- 初始化 ---------- */
let state = {page:"overview", feedCat:"", feedSort:"active", tlStatus:"", tlSrc:"", srView:"list",
  calYear:new Date().getFullYear(), calMonth:new Date().getMonth()};

/* 读取内置数据快照（data.js 里的 window.TRAE_BAKED_DATA，构建期生成）
   用 <script src> 加载而非 fetch，所以 file:// 双击打开也能读到 */
function bakedData(){
  if(window.TRAE_BAKED_DATA && window.TRAE_BAKED_DATA.items) return window.TRAE_BAKED_DATA;
  return null;
}

function init(){
  Store.load();
  const baked = bakedData();
  const hadLocal = Store.items().length > 0;

  if(baked && baked.items && baked.items.length){
    if(!hadLocal){
      // 首次打开（比如别人收到 HTML）：直接用内置快照
      Store.data = {version:1, items:baked.items, log:[], lastFetch:baked.lastFetch || null};
      Store.logPush({t:new Date().toISOString(), msg:"载入内置数据快照"+(baked.generatedAt?("（生成于 "+fmtDate(baked.generatedAt)+"）"):""), add:baked.items.length});
      Store.save();
    } else {
      // 已有本地数据：合并内置快照，保留收藏标记
      let n = 0;
      for(const it of baked.items){
        const old = Store.byId(it.id);
        if(old && old.flags && old.flags.starred) it.flags.starred = true;
        if(!old) n++;
        Store.upsert(it);
      }
      if(n){
        Store.logPush({t:new Date().toISOString(), msg:"合并内置数据快照", add:n});
        Store.save();
      }
    }
  } else if(!hadLocal){
    // 无内置快照也无本地数据 → 退回最小种子数据
    const seeds = seedItems();
    for(const it of seeds) Store.upsert(it);
    Store.logPush({t:new Date().toISOString(), msg:"载入内置种子数据", add:seeds.length});
    Store.save();
  }

  buildCatOptions();
  bindEvents();
  refreshDataStat();
  goPage("overview");
  renderOverview();
  pingBackend();   // 检测本地后端，更新顶栏状态灯
}

function buildCatOptions(){
  const cats = CFG.actCats.concat(CFG.feedCats);
  const optHtml = '<option value="">全部板块</option>' + cats.map(c =>
    '<option value="'+c.id+'">'+esc(c.name)+'</option>').join("");
  $("#fdCat").innerHTML = optHtml;
  $("#srCat").innerHTML = optHtml;
}

/* ---------- 导航 ---------- */
function goPage(p){
  state.page = p;
  $$(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.page === p));
  $$(".page").forEach(s => s.classList.toggle("active", s.id === "page-"+p));
  const meta = {overview:["概览","OVERVIEW"], timeline:["活动时间线","ACTIVITY TIMELINE"],
    feed:["论坛信息流","FORUM FEED"], search:["全局检索","SEARCH"], manage:["数据管理","DATA"]}[p];
  $("#hdTitle").textContent = meta[0];
  $("#hdCrumb").textContent = meta[1];
  if(p==="overview") renderOverview();
  if(p==="timeline") renderTimeline();
  if(p==="feed") renderFeed();
  if(p==="search") renderSearch();
  if(p==="manage") renderManage();
}

function refreshDataStat(){
  const items = Store.items();
  const n = items.length;
  const lf = Store.data.lastFetch;
  $("#dataStat").textContent = n+" 条"+(lf?" · 上次 "+relTime(lf):" · 未抓取");
  $("#dataStat").title = "已收录条目 "+n+" · 上次抓取 "+(lf?fmtDT(lf):"-");
  $("#mgCount").textContent = "共 "+n+" 条";
}

/* ---------- 事件绑定 ---------- */
function bindEvents(){
  $$(".nav-item").forEach(n => n.addEventListener("click", ()=>goPage(n.dataset.page)));
  $("#btnToggleNav").addEventListener("click", ()=>$("#nav").classList.toggle("collapsed"));

  // 点顶栏「抓取通道」查看当前通道说明
  $("#backendState").addEventListener("click", ()=>{
    updateBackendBadge();
    const el = $("#backendState");
    toast(el.title, canFetchFromPage() ? "ok" : "err");
  });

  const doFetch = ()=>runFetch();
  $("#btnFetch").addEventListener("click", doFetch);
  $("#hdFetch").addEventListener("click", doFetch);
  $("#btnExport").addEventListener("click", exportJSON);
  $("#btnImport").addEventListener("click", ()=>$("#fileImp").click());
  $("#fileImp").addEventListener("change", importFile);
  $("#mExport").addEventListener("click", exportJSON);
  $("#mImport").addEventListener("click", ()=>$("#fileImp").click());
  $("#mClearData").addEventListener("click", resetAndFetch);
  $("#mPasteParse").addEventListener("click", ()=>parsePaste($("#mPaste").value));
  $("#mSave").addEventListener("click", saveManual);
  $("#mClear").addEventListener("click", ()=>$("#mStart").value=$("#mEnd").value=$("#mTitle").value=$("#mReq").value=$("#mUrl").value="");
  // 自建代理地址
  $("#mCustomProxy").value = getCustomProxy();
  $("#mCustomProxySave").addEventListener("click", ()=>{
    let v = $("#mCustomProxy").value.trim();
    if(!v) return toast("请先填入自建代理地址","err");
    if(!/^https?:\/\//i.test(v)) return toast("地址需以 http:// 或 https:// 开头","err");
    try{ localStorage.setItem(CFG.proxyUrlStore, v); }catch(e){ return toast("保存失败："+e.message,"err"); }
    $("#mCustomProxyState").textContent = "";
    toast("自建代理已保存，抓取将优先使用它","ok");
  });
  $("#mCustomProxyClear").addEventListener("click", ()=>{
    try{ localStorage.removeItem(CFG.proxyUrlStore); }catch(e){}
    $("#mCustomProxy").value = "";
    $("#mCustomProxyState").textContent = "";
    toast("已清除自建代理","ok");
  });
  $("#mCustomProxyTest").addEventListener("click", async ()=>{
    const el = $("#mCustomProxyState");
    let v = $("#mCustomProxy").value.trim();
    if(!v) return toast("请先填入自建代理地址","err");
    if(!/^https?:\/\//i.test(v)) return toast("地址需以 http:// 或 https:// 开头","err");
    const tgt = encodeURIComponent(CFG.base + "/c/29-category/29.json");
    const full = buildProxyUrl(v, tgt);
    el.style.color = "var(--muted)";
    el.textContent = "测试中…";
    try{
      const ctrl = new AbortController();
      const to = setTimeout(()=>ctrl.abort(), 15000);
      const r = await fetch(full, {signal: ctrl.signal});
      clearTimeout(to);
      const body = await r.text().catch(()=>"");
      if(!r.ok){
        el.style.color = "var(--danger)";
        el.textContent = "失败 · HTTP "+r.status+(body?(" · "+body.slice(0,80)):"");
        toast("自建代理返回 HTTP "+r.status,"err");
        return;
      }
      let topics = -1;
      try{ topics = (JSON.parse(body).topic_list?.topics||[]).length; }catch(e){}
      el.style.color = "var(--ok)";
      el.textContent = "连通正常 · 拿到 "+(topics>=0?topics:"?")+" 个话题";
      toast("自建代理连通正常","ok");
    }catch(e){
      el.style.color = "var(--danger)";
      el.textContent = "失败 · "+(e.name||"")+" "+(e.message||"");
      toast("自建代理连接失败："+e.message,"err");
    }
  });
  // 抓取代理 API Key
  $("#mProxyKey").value = getProxyKey();
  $("#mProxyKeySave").addEventListener("click", ()=>{
    const v = $("#mProxyKey").value.trim();
    if(!v) return toast("请先填入 API Key","err");
    try{ localStorage.setItem(CFG.proxyKeyStore, v); }catch(e){ return toast("保存失败："+e.message,"err"); }
    toast("API Key 已保存，可重新抓取","ok");
  });
  $("#mProxyKeyClear").addEventListener("click", ()=>{
    try{ localStorage.removeItem(CFG.proxyKeyStore); }catch(e){}
    $("#mProxyKey").value = "";
    toast("已清除 API Key","ok");
  });
  // 请求频率
  $("#mFreq").value = getFreq();
  $("#mFreqSave").addEventListener("click", ()=>{
    const v = $("#mFreq").value;
    if(!CFG.freqLevels[v]) return toast("无效的频率档位","err");
    try{ localStorage.setItem(CFG.freqStore, v); }catch(e){ return toast("保存失败："+e.message,"err"); }
    toast("频率已设为「"+CFG.freqLevels[v].label+"」，下次抓取生效","ok");
  });

  // 时间线
  $("#tlQ").addEventListener("input", renderTimeline);
  $("#tlStatus").addEventListener("change", ()=>{state.tlStatus=$("#tlStatus").value; renderTimeline();});
  $("#tlSrc").addEventListener("change", ()=>{state.tlSrc=$("#tlSrc").value; renderTimeline();});
  $$(".vtabs .vt").forEach(v => v.addEventListener("click", ()=>{
    $$(".vtabs .vt").forEach(x=>x.classList.remove("on")); v.classList.add("on");
    const grp = v.closest(".fbar") ? "tl" : (v.dataset.vt==="table"?"sr":"sr");
    if(v.closest("#page-timeline")){
      state.tlView = v.dataset.vt;
      $("#tlList").style.display = state.tlView==="list" ? "" : "none";
      $("#tlCal").style.display = state.tlView==="cal" ? "" : "none";
      if(state.tlView==="cal") renderCal();
    } else {
      state.srView = v.dataset.vt;
      renderSearch();
    }
  }));
  $("#calPrev").addEventListener("click", ()=>{state.calMonth--; if(state.calMonth<0){state.calMonth=11;state.calYear--;} renderCal();});
  $("#calNext").addEventListener("click", ()=>{state.calMonth++; if(state.calMonth>11){state.calMonth=0;state.calYear++;} renderCal();});
  $("#calToday").addEventListener("click", ()=>{state.calYear=new Date().getFullYear(); state.calMonth=new Date().getMonth(); renderCal();});

  // 信息流
  $("#fdQ").addEventListener("input", renderFeed);
  $("#fdCat").addEventListener("change", ()=>{state.feedCat=$("#fdCat").value; renderFeed();});
  $("#fdKind").addEventListener("change", renderFeed);
  $("#fdSort").addEventListener("change", ()=>{state.feedSort=$("#fdSort").value; renderFeed();});

  // 检索
  $("#srQ").addEventListener("keydown", e=>{ if(e.key==="Enter") renderSearch(); });
  $("#srBtn").addEventListener("click", renderSearch);
  ["srSrc","srKind","srCat","srSt"].forEach(id=> $("#"+id).addEventListener("change", renderSearch));

  // 弹层
  $("#mClose").addEventListener("click", ()=>$("#modal").classList.remove("show"));
  $("#mClose2").addEventListener("click", ()=>$("#modal").classList.remove("show"));
  $("#modal").addEventListener("click", e=>{ if(e.target.id==="modal") $("#modal").classList.remove("show"); });
}

/* ============================================================
   抓取器（M2）：Discourse API + CORS 代理 + 增量合并
   ============================================================ */
let fetchBusy = false;
async function runFetch(){
  if(fetchBusy) return;
  fetchBusy = true;
  const st = $("#fetchState");
  st.style.display = "flex";
  const setTxt = t => $("#fetchStateText").textContent = t;
  let added = 0, updated = 0;
  try{
    // 0. 前置检查：file:// 打开时公共代理会拒绝（Origin 为 null），直接给明确提示
    updateBackendBadge();
    if(!canFetchFromPage()){
      throw new Error("当前是 file:// 直接打开，浏览器跨域请求会被代理拒绝（Origin 为 null）。把本文件夹放到任意 http(s) 网址下访问即可动态抓取；此刻可直接浏览内置快照数据。");
    }
    // 1. 活动源：福利活动板块（全量抓）
    setTxt("抓取福利活动板块…");
    const r1 = await fetchCategoryTopics(CFG.actCats, CFG.actPages);
    added += r1.added; updated += r1.updated;
    // 2. 信息流板块（官方活动 + 干货，最新 N 页，不拉正文）
    setTxt("抓取论坛信息流…");
    const r2 = await fetchCategoryTopics(CFG.feedCats, CFG.feedPages);
    added += r2.added; updated += r2.updated;
    // 3. 补全活动时间：拉取时间缺失的福利活动帖子正文，提取开始/截止，同时清除已开奖的
    setTxt("补全活动时间…");
    const r3 = await ensureActivityTimes();
    updated += r3.done;
    Store.data.lastFetch = new Date().toISOString();
    Store.logPush({t:new Date().toISOString(), msg:"手动抓取完成", add:added, upd:updated, del:(r3.removed||0)});
    Store.save();
    refreshDataStat();
    renderAll();
    const parts = ["新增 "+added+" 条", "更新 "+updated+" 条"];
    if(r3.removed) parts.push("清除已开奖 "+r3.removed+" 条");
    if(r3.fail) parts.push(r3.fail+" 条时间提取失败");
    toast("抓取完成："+parts.join("，"), "ok");
  }catch(err){
    Store.logPush({t:new Date().toISOString(), msg:"抓取失败："+err.message});
    Store.save();
    toast("抓取失败："+err.message, "err");
  }finally{
    st.style.display = "none";
    fetchBusy = false;
  }
}

/* 获取当前生效的 corsproxy.io API Key：数据管理页(存在 localStorage，优先) > CFG.proxyKey */
function getProxyKey(){
  try{ return localStorage.getItem(CFG.proxyKeyStore) || ""; }catch(e){ return ""; }
}

/* 获取自建代理地址（Cloudflare Worker 等）：数据管理页(存在 localStorage，优先) > CFG.customProxy */
function getCustomProxy(){
  let v = "";
  try{ v = localStorage.getItem(CFG.proxyUrlStore) || ""; }catch(e){}
  return (v || CFG.customProxy || "").trim();
}

/* 把目标 URL 拼到自定义代理地址上：支持填基础地址或已含 url= 参数的地址 */
function buildProxyUrl(base, target){
  const b = (base||"").trim();
  if(!b) return null;
  if(/[?&]url=$/.test(b) || /[?&]url=/.test(b)) return b + target;
  return b + (b.includes("?") ? "&" : "?") + "url=" + target;
}

/* 获取当前请求频率档位：localStorage > 默认 low */
function getFreq(){
  try{
    const v = localStorage.getItem(CFG.freqStore);
    if(v && CFG.freqLevels[v]) return v;
  }catch(e){}
  return CFG.freqDefault;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 页面是否处于「可抓取」协议：file:// 打开时浏览器会把 Origin 记为 null，
   多数公共代理（含实测可用的 corsfix）会直接拒绝，因此只有 http(s) 才能动态抓取 */
function canFetchFromPage(){
  return location.protocol === "http:" || location.protocol === "https:";
}

/* 更新顶栏「抓取通道」状态灯 */
function updateBackendBadge(){
  const el = $("#backendState");
  if(!el) return;
  if(!canFetchFromPage()){
    el.textContent = "仅静态数据";
    el.className = "badge r";
    el.title = "当前是 file:// 直接打开，公共代理会拒绝（Origin 为 null）。把本文件夹放到任意 http(s) 网址下访问即可动态抓取；内置快照仍可正常浏览。";
    return;
  }
  const custom = getCustomProxy();
  const key = getProxyKey() || CFG.proxyKey;
  el.textContent = custom ? "自建代理" : (key ? "corsproxy" : "公共代理");
  el.className = "badge g";
  el.title = "抓取通道：" + (custom ? custom
      : key ? "corsproxy.io（带 API Key）"
      : "corsfix 公共代理（实测可用，建议 1 秒 1 次）");
}

/* 刷新状态灯（兼容旧调用名） */
async function pingBackend(){
  updateBackendBadge();
  return canFetchFromPage();
}

/* 通过代理请求论坛 JSON（发起前按频率档位限速）
   通道优先级：自建代理 > corsfix > corsproxy.io(带Key) > allorigins */
async function fetchViaProxy(url){
  const freq = getFreq();
  await sleep(CFG.freqLevels[freq].interval);
  const key = getProxyKey() || CFG.proxyKey;
  const custom = getCustomProxy();
  const enc = encodeURIComponent(url);
  const targets = [];
  // 1) 自建代理（Cloudflare Worker，最稳）
  if(custom){
    const cu = buildProxyUrl(custom, enc);
    if(cu) targets.push({name:"自建代理", url:cu});
  }
  // 2) corsfix 公共代理（sdk=1 免注册免费档；要求目标 URL 编码后再拼）
  if(CFG.corsfixProxy){
    targets.push({name:"corsfix", url:CFG.corsfixProxy + enc});
  }
  // 3) corsproxy.io（有 Key 时）
  if(key){
    targets.push({name:"corsproxy", url:"https://corsproxy.io/?key="+encodeURIComponent(key)+"&url="+enc});
  }
  // 4) allorigins 兜底
  targets.push({name:"allorigins", url:"https://api.allorigins.win/raw?url="+enc});

  let lastErr = null, lastName = "";
  for(const t of targets){
    try{
      const ctrl = new AbortController();
      const to = setTimeout(()=>ctrl.abort(), 20000);
      const r = await fetch(t.url, {signal: ctrl.signal, cache: "no-store"});
      clearTimeout(to);
      if(!r.ok){
        const body = await r.text().catch(()=>"");
        throw new Error("HTTP "+r.status+(body?(" "+body.slice(0,100)):""));
      }
      return await r.json();
    }catch(e){ lastErr = e; lastName = t.name; }
  }

  // 分层错误提示
  const msg = (lastErr&&lastErr.message)||"网络错误";
  let hint = "";
  if(!canFetchFromPage()){
    hint = "当前是 file:// 直接打开，公共代理会拒绝（Origin 为 null）。把整个文件夹部署到任意 http(s) 网址（或本地起静态服务）后访问即可动态抓取；此刻仍可浏览内置快照数据。";
  } else if(/HTTP 400/.test(msg)){
    hint = "代理拒绝（400）：多为页面来源不被允许。可换自建代理，或在数据管理页配置 corsproxy Key。";
  } else if(/HTTP 401/.test(msg)){
    hint = "代理鉴权失败（401）：corsproxy 的 API Key 缺失或无效，请到「数据管理 → 抓取通道设置」检查。";
  } else if(/HTTP 403/.test(msg)){
    hint = "代理拒绝（403）：可能额度用尽或被限流。建议降低「请求频率」，或配置自建代理。";
  } else if(/HTTP 429/.test(msg)){
    hint = "触发代理限流（429）：请把「请求频率」调到低频，或配置自建代理。";
  } else if(/HTTP 5\d\d/.test(msg)){
    hint = "代理服务端异常（5xx）：公共代理不稳定，建议配置自建 Cloudflare Worker 代理。";
  } else {
    hint = "所有通道均失败：可到「数据管理 → 抓取通道设置」配置自建代理；或直接浏览内置快照数据。";
  }
  throw new Error("抓取失败（最后尝试："+lastName+"）："+msg+" —— "+hint);
}

/* 拉取板块话题列表并增量合并 */
async function fetchCategoryTopics(cats, pages){
  let added = 0, updated = 0;
  for(const cat of cats){
    for(let pg = 0; pg < pages; pg++){
      const url = CFG.base + cat.path + (pg>0?("?page="+pg):"");
      let json;
      try{ json = await fetchViaProxy(url); }
      catch(e){ if(pg===0) toast("板块「"+cat.name+"」抓取失败："+e.message, "err"); break; }
      const list = json.topic_list || {};
      const topics = list.topics || [];
      if(!topics.length) break;
      // Discourse 列表里作者在顶层 users 数组，建立 id→用户名 映射
      const userMap = {};
      for(const u of (json.users||[])) userMap[u.id] = u.username;
      const res = mergeTopics(topics, cat, userMap);
      added += res.added; updated += res.updated;
      if(topics.length < (list.per_page||30)) break; // 没有更多页
    }
  }
  return {added, updated};
}

function mergeTopics(topics, cat, userMap){
  let added = 0, updated = 0;
  for(const t of topics){
    // 已结束/已开奖的帖子：删除本地存量（若有旧标题记录）后跳过，一律不收录
    if(isEndedTitle(t.title)){ Store.remove("t-"+t.id); continue; }
    const id = "t-"+t.id;
    const item = {
      id, source:"forum", catId:cat.id, category:cat.name, kind:null,
      title: t.title || "", excerpt: stripHtml(t.excerpt||""), content: null,
      tags: (t.tags||[]).slice(0,6), author: resolveAuthor(t, userMap),
      created: t.created_at, active: t.last_posted_at||t.bumped_at||t.created_at,
      stats:{posts:t.posts_count||0, replies:t.reply_count||0, views:t.views||0, likes:t.like_count||0},
      image: t.image_url || null,
      url: CFG.base + "/t/topic/"+t.id,
      feishuLinks: [], activity: null,
      flags:{official:null, is_activity:null, starred:false}
    };
    item.kind = guessKind(item);
    item.flags.official = isOfficial(item);
    item.flags.is_activity = item.kind === "activity";
    // 板块说明帖（置顶的「关于 XX 板块」）不是活动，归 other
    if(/^关于[\u201c"']?[^，。]{1,12}板块/.test(item.title||"")){
      item.kind = "other"; item.flags.is_activity = false;
    }
    // 官方活动：列表阶段先做摘要级时间弱提取；无日期的也保留 activity 对象（福利/长期活动），保证全部进时间线
    if(item.flags.is_activity){
      item.activity = guessActivity(item, "") || {start:null, end:null, requirement:item.excerpt.slice(0,200), signup_url:item.url};
    }
    const old = Store.byId(id);
    if(old){
      updated++;
      const merged = Object.assign({}, old, item);
      if(old.starred) merged.flags.starred = true;
      Store.upsert(merged);
    } else {
      added++;
      Store.upsert(item);
    }
  }
  return {added, updated};
}

function resolveAuthor(t, userMap){
  const p = t.posters && t.posters[0];
  if(p && userMap && userMap[p.user_id] !== undefined) return userMap[p.user_id];
  if(t.last_poster_username) return t.last_poster_username;
  return "未知";
}

function stripHtml(html){
  const d = document.createElement("div");
  d.innerHTML = html;
  return (d.textContent||"").replace(/\s+/g," ").trim();
}

/* 拉取帖子正文（按需，点开详情时调用），提取飞书链接 + 活动要求 */
async function fetchTopicDetail(item){
  const id = item.id.replace("t-","");
  const url = CFG.base + "/t/"+id+".json";
  const json = await fetchViaProxy(url);
  const posts = (json.post_stream && json.post_stream.posts) || [];
  const first = posts[0];
  if(!first) return item;
  const cooked = first.cooked || "";
  item.content = stripHtml(cooked);
  item.feishuLinks = extractFeishuLinks(cooked);
  const act = guessActivity(item, cooked);
  if(act) item.activity = act;
  return item;
}

/* 补全活动时间：拉取时间缺失的福利活动帖子正文，提取开始/截止（并发 4，容错） */
async function ensureActivityTimes(){
  const need = Store.items().filter(i =>
    i.source === "forum" && i.catId === 29 && i.flags.is_activity &&
    !(i.activity && (i.activity.start || i.activity.end)) && !i.content &&
    !isEndedTitle(i.title));
  let done = 0, fail = 0, removed = 0;
  const conc = CFG.freqLevels[getFreq()].concurrency;
  for(let i = 0; i < need.length; i += conc){
    await Promise.all(need.slice(i, i+conc).map(async it => {
      try{
        await fetchTopicDetail(it);
        // 正文揭示已开奖 → 删除该条目（标题可能无标记）
        if(isEndedText(it.content) || isEndedTitle(it.title)){
          Store.remove(it.id); removed++;
          return;
        }
        if(it.activity && (it.activity.start || it.activity.end)) done++; else fail++;
        Store.upsert(it);
      }catch(e){ fail++; }
    }));
  }
  return {done, fail, removed};
}

function extractFeishuLinks(html){
  const re = /https?:\/\/(?:[a-z0-9-]+\.)?(?:feishu\.cn|larkoffice\.com|applink\.feishu\.cn|larksuite\.com)\/[^\s"'<)]+/gi;
  const out = [];
  const raw = html.match(re) || [];
  for(const u of raw){
    const clean = u.replace(/[)\]}>]+$/,"").replace(/&amp;/g,"&");
    if(!out.includes(clean)) out.push(clean);
  }
  return out.slice(0,5);
}

function guessActivity(item, cooked){
  // 提取活动时间：优先匹配「活动时间/报名截止」等语义关键词与标题日期区间；
  // 匹配不到明确活动时间就返回 null（显示"时间未注明"），避免把正文里的背景日期误当活动时间
  const text = (item.title||"") + " " + item.excerpt + " " + (cooked||"").replace(/<[^>]+>/g," ");
  const act = {start:null, end:null, requirement:"", signup_url:item.url};
  if(item.kind === "activity" && item.excerpt) act.requirement = item.excerpt.slice(0,200);

  // 1) 日期区间：X月X日 - Y月Y日 / X.X-Y.Y / X-X（标题里的区间，如「7.21-8.9必看」）
  const rangeRe = /(\d{1,2})[月.\/-](\d{1,2})日?[\s~至到\-—]{1,4}(\d{1,2})[月.\/-](\d{1,2})日?/g;
  let m;
  while((m = rangeRe.exec(text))){
    const y = new Date().getFullYear();
    act.start = buildDate(y, +m[1], +m[2]);
    act.end = buildDate(y, +m[3], +m[4]);
    return act;
  }

  // 2) 活动时间关键词：取关键词后 40 字符内的日期（多数只有一个截止时间）
  const kwRe = /(?:活动时间|活动日期|报名时间|报名截止|截止时间|截止日期|截止至|征集时间|征集截止|投稿时间|参赛时间|比赛时间|时间安排|赛程|即日起至)[^\n。；;]{0,40}/g;
  const kws = text.match(kwRe);
  if(kws && kws.length){
    const dates = [];
    for(const kw of kws){
      const ds = kw.match(/(\d{4}年\d{1,2}月\d{1,2}日|[12]\d{3}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}月\d{1,2}日)/g) || [];
      dates.push(...ds);
    }
    if(dates.length){
      act.start = normDate2(dates[0]);
      act.end = dates.length > 1 ? normDate2(dates[dates.length-1]) : act.start;
      return act;
    }
  }

  // 3) 标题里带完整日期（标题日期通常与活动直接相关）
  const fullRe = /(\d{4}年\d{1,2}月\d{1,2}日|[12]\d{3}[-/.]\d{1,2}[-/.]\d{1,2})/g;
  const titleDates = (item.title||"").match(fullRe);
  if(titleDates && titleDates.length){
    act.start = normDate2(titleDates[0]);
    if(titleDates.length > 1) act.end = normDate2(titleDates[titleDates.length-1]);
    return act;
  }

  return null; // 无明确活动时间 → 不设置，显示"时间未注明"
}
function buildDate(y, mo, d){
  return new Date(y, mo-1, d).toISOString();
}
function normDate2(s){
  const m = s.match(/(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})/);
  if(m) return new Date(+m[1], +m[2]-1, +m[3]).toISOString();
  const m2 = s.match(/^(\d{1,2})月(\d{1,2})日/);
  if(m2) return buildDate(new Date().getFullYear(), +m2[1], +m2[2]);
  return null;
}

/* ---------- 导出 / 导入 / 粘贴 / 清空 ---------- */
function exportJSON(){
  const blob = new Blob([JSON.stringify(Store.data, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "TRAE情报台-备份-"+fmtDate(new Date().toISOString())+".json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("已导出备份 JSON","ok");
}
function importFile(e){
  const f = e.target.files[0];
  if(!f) return;
  const rd = new FileReader();
  rd.onload = ()=>parsePaste(String(rd.result));
  rd.readAsText(f);
  e.target.value = "";
}
function parsePaste(str){
  str = (str||"").trim();
  if(!str) return toast("请先粘贴内容","err");
  try{
    const json = JSON.parse(str);
    let n = 0;
    if(json.items && Array.isArray(json.items)){
      for(const it of json.items){ Store.upsert(it); n++; }
      Store.data.lastFetch = json.lastFetch || Store.data.lastFetch;
    } else if(json.topic_list && json.topic_list.topics){
      const cat = {id:0, name:"手动导入"};
      const res = mergeTopics(json.topic_list.topics, cat);
      n = res.added + res.updated;
    } else if(Array.isArray(json)){
      for(const it of json) if(Store.upsert(it)) n++;
    } else {
      return toast("无法识别的 JSON 结构","err");
    }
    Store.logPush({t:new Date().toISOString(), msg:"JSON 导入/解析", add:n});
    Store.save();
    refreshDataStat();
    renderAll();
    toast("导入成功："+n+" 条","ok");
  }catch(e){ toast("JSON 解析失败："+e.message,"err"); }
}
function resetAndFetch(){
  if(!confirm("将清空全部数据，恢复种子数据并按新规则重新抓取论坛最新内容，确认？")) return;
  if(fetchBusy) return toast("抓取进行中，请稍后再试","err");
  const seeds = seedItems();
  Store.data = {version:1, items:seeds, log:[{t:new Date().toISOString(), msg:"清空并重置，载入种子数据", add:seeds.length}], lastFetch:null};
  Store.save();
  refreshDataStat();
  renderAll();
  toast("已清空，开始重新抓取…");
  setTimeout(runFetch, 400);
}

/* ---------- 手动录入 ---------- */
function saveManual(){
  const title = $("#mTitle").value.trim();
  if(!title) return toast("请填写活动标题","err");
  const start = $("#mStart").value, end = $("#mEnd").value;
  const item = {
    id: "m-"+Date.now(), source:"manual", catId:0, category:"手动录入", kind:$("#mKind").value,
    title, excerpt:$("#mReq").value.trim().slice(0,300), content:$("#mReq").value.trim(),
    tags:[], author:"我", created:new Date().toISOString(), active:new Date().toISOString(),
    stats:{posts:0,replies:0,views:0,likes:0}, image:null,
    url:$("#mUrl").value.trim(), feishuLinks: $("#mUrl").value.trim()?[$("#mUrl").value.trim()]:[],
    activity: start||end ? {start:start?new Date(start).toISOString():null, end:end?new Date(end).toISOString():null,
      requirement:$("#mReq").value.trim(), signup_url:$("#mUrl").value.trim()} : null,
    flags:{official:true, is_activity:true, starred:false}
  };
  Store.upsert(item);
  Store.logPush({t:new Date().toISOString(), msg:"手动录入："+title});
  Store.save();
  refreshDataStat();
  renderAll();
  toast("已录入："+title,"ok");
}

/* ---------- 弹层详情 ---------- */
async function openDetail(item){
  const m = $("#modal");
  $("#mTitle2").textContent = item.title;
  let reqHtml = item.excerpt ? "<p class='ex' style='color:var(--muted);margin-bottom:12px'>"+esc(item.excerpt)+"</p>" : "";
  // 详情内容：有正文用正文，否则提示可按需抓取
  if(item.content){
    reqHtml += "<div style='font:13px/1.7 var(--sans);color:var(--text);white-space:pre-wrap'>"+esc(item.content)+"</div>";
  } else {
    reqHtml += "<div style='margin:8px 0'><button class='btn primary' id='mLoadBody'>按需抓取正文</button></div>";
  }
  const badges = [];
  badges.push(item.source==="forum"?'<span class="badge o">论坛</span>':item.source==="feishu"?'<span class="badge i">飞书</span>':'<span class="badge g">手动</span>');
  if(item.flags.official) badges.push('<span class="badge y">官方</span>');
  else badges.push('<span class="badge">伙伴</span>');
  if(item.activity){
    const st = actStatus(item.activity);
    const stTxt = {running:"进行中",upcoming:"未开始",ended:"已结束"}[st]||"";
    if(stTxt) badges.push('<span class="badge '+(st==="running"?"y":st==="upcoming"?"i":"")+'">'+stTxt+'</span>');
  }
  let actHtml = "";
  if(item.activity){
    actHtml += "<div class='panel' style='margin-top:12px'><div class='p-hd'>活动信息 <span class='p-sub'>可手动修正时间</span></div><div class='p-bd' style='display:grid;gap:8px'>";
    if(item.activity.start) actHtml += "<div><label>开始</label><div>"+fmtDT(item.activity.start)+"</div></div>";
    if(item.activity.end) actHtml += "<div><label>截止</label><div>"+fmtDT(item.activity.end)+"</div></div>";
    if(item.activity.requirement) actHtml += "<div><label>要求</label><div style='color:var(--text);font:13px/1.7 var(--sans)'>"+esc(item.activity.requirement)+"</div></div>";
    if(item.activity.signup_url) actHtml += "<div><label>报名入口</label><div><a href='"+esc(item.activity.signup_url)+"' target='_blank'>"+esc(item.activity.signup_url)+"</a></div></div>";
    actHtml += "<div style='display:flex;gap:10px;align-items:flex-end;margin-top:6px'>"+
      "<div><label>开始时间</label><input type='datetime-local' id='actEditStart' value='"+toLocalDT(item.activity.start)+"'></div>"+
      "<div><label>截止时间</label><input type='datetime-local' id='actEditEnd' value='"+toLocalDT(item.activity.end)+"'></div>"+
      "<button class='btn primary' id='actEditSave'>保存时间</button></div>";
    actHtml += "</div></div>";
  }
  let fl = "";
  if(item.feishuLinks && item.feishuLinks.length){
    fl = "<div class='panel' style='margin-top:12px'><div class='p-hd'>关联飞书链接</div><div class='p-bd' style='display:grid;gap:6px'>"+
      item.feishuLinks.map(u=>"<div><a href='"+esc(u)+"' target='_blank'>"+esc(u)+"</a></div>").join("")+"</div></div>";
  }
  $("#mBody2").innerHTML =
    "<div style='display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px'>"+badges.join("")+
    (item.category?'<span class="badge">'+esc(item.category)+'</span>':"")+
    (item.tags||[]).map(t=>'<span class="chip y">'+esc(t)+'</span>').join("")+"</div>"+
    "<div style='font:11px/1.6 var(--mono);color:var(--dim);margin-bottom:12px'>作者："+esc(item.author||"-")+
    " · 发布："+fmtDT(item.created)+" · 活跃："+relTime(item.active)+
    " · 回复 "+(item.stats.replies||0)+" · 浏览 "+(item.stats.views||0)+"</div>"+
    reqHtml + actHtml + fl +
    "<div style='margin-top:14px'><a href='"+esc(item.url||"#")+"' target='_blank'>前往原帖 ↗</a></div>";
  m.classList.add("show");
  const btn = $("#mLoadBody");
  if(btn) btn.addEventListener("click", async ()=>{
    btn.disabled = true; btn.textContent = "抓取中…";
    try{
      await fetchTopicDetail(item);
      Store.upsert(item);
      Store.save();
      openDetail(item);
      toast("正文已缓存","ok");
    }catch(e){ btn.disabled=false; btn.textContent="抓取失败，重试"; toast("正文抓取失败："+e.message,"err"); }
  });
  const saveTime = $("#actEditSave");
  if(saveTime) saveTime.addEventListener("click", ()=>{
    const s = $("#actEditStart").value, e = $("#actEditEnd").value;
    if(!item.activity) item.activity = {start:null,end:null,requirement:"",signup_url:item.url};
    item.activity.start = s ? new Date(s).toISOString() : null;
    item.activity.end = e ? new Date(e).toISOString() : null;
    Store.upsert(item);
    Store.save();
    refreshDataStat(); renderAll();
    toast("活动时间已更新","ok");
  });
}
// datetime-local 输入值（本地时间 → YYYY-MM-DDTHH:mm）
function toLocalDT(iso){
  if(!iso) return "";
  const d = new Date(iso);
  const p = n => String(n).padStart(2,"0");
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+"T"+p(d.getHours())+":"+p(d.getMinutes());
}

/* ---------- 渲染（M3-M6） ---------- */
function actBadge(a){
  const st = actStatus(a);
  const map = {running:["进行中","st-running"], upcoming:["未开始","st-upcoming"], ended:["已结束","st-ended"]};
  if(!st || !map[st]) return "";
  return '<span class="badge '+map[st][1]+'">'+map[st][0]+'</span>';
}
function starBtn(item){
  return '<button class="icon" style="width:26px;height:26px;min-height:26px" title="收藏/取消收藏" onclick="toggleStar(\''+item.id+'\')">'+
    (item.flags.starred?'<span style="color:var(--accent)">★</span>':'<span>☆</span>')+'</button>';
}
function toggleStar(id){
  const it = Store.byId(id);
  if(!it) return;
  it.flags.starred = !it.flags.starred;
  Store.save(); refreshDataStat(); renderAll();
  toast(it.flags.starred?"已收藏 ☆":"已取消收藏","ok");
}
function actCard(it, compact){
  const a = it.activity || {};
  const st = actStatus(a);
  const cd = (st==="running" && a.end) ? countdown(a.end) : (st==="upcoming" && a.start) ? countdown(a.start) : null;
  return '<div class="post">'+
    '<div class="pt">'+
      '<div class="tt" onclick="openDetail(Store.byId(\''+it.id+'\'))">'+esc(it.title)+'</div>'+
      '<div class="meta"><span class="badge '+(it.flags.official?"y":"")+'">'+(it.flags.official?"官方":"伙伴")+'</span>'+
        actBadge(a)+
        (it.category?'<span class="badge">'+esc(it.category)+'</span>':"")+
        '<span class="sep">|</span>'+esc(it.source==="forum"?"论坛":it.source==="feishu"?"飞书":"手动")+
        '<span class="sep">|</span>'+esc(it.author||"-")+
        '<span class="sep">|</span>'+relTime(it.active)+
        '<span style="margin-left:auto">'+starBtn(it)+'</span></div>'+
      (a.requirement?'<div class="ex" style="margin-top:6px">'+esc(a.requirement)+'</div>':"")+
      '<div class="meta" style="margin-top:6px">'+
        (a.start?'<span style="color:var(--info)">开始 '+fmtDT(a.start)+'</span>':"")+
        (a.end?'<span>截止 '+fmtDT(a.end)+'</span>':"")+
        (!a.start && !a.end ? '<span style="color:var(--dim)">时间未注明 · 详见正文</span>' : "")+
        (cd?'<span class="cd '+(cd.cls||"")+'">'+cd.txt+' <small>'+((st==="running")?"后截止":"后开始")+'</small></span>':"")+
      '</div>'+
    '</div></div>';
}
function postCard(it){
  return '<div class="post" id="post-'+it.id+'">'+
    '<div class="pt">'+
      '<div class="tt" onclick="openDetail(Store.byId(\''+it.id+'\'))">'+esc(it.title)+'</div>'+
      '<div class="meta"><span class="badge '+(it.flags.official?"y":"")+'">'+(it.flags.official?"官方":"伙伴")+'</span>'+
        (it.kind?('<span class="badge">'+({activity:"活动",notice:"公告",welfare:"福利",share:"伙伴分享",help:"求助",other:"其他"}[it.kind]||it.kind)+'</span>'):"")+
        (it.category?'<span class="badge">'+esc(it.category)+'</span>':"")+
        '<span class="sep">|</span>'+esc(it.author||"-")+
        '<span class="sep">|</span>'+relTime(it.created)+
        '<span style="margin-left:auto">'+starBtn(it)+'</span></div>'+
      (it.excerpt?'<div class="ex">'+esc(it.excerpt)+'</div>':"")+
      (it.feishuLinks && it.feishuLinks.length?'<div class="meta" style="margin-top:6px"><span class="badge i">飞书链接</span>'+
        it.feishuLinks.slice(0,2).map(u=>'<a href="'+esc(u)+'" target="_blank" style="font-size:11px">'+esc(u.replace(/^https?:\/\//,"").slice(0,40))+'…</a>').join("")+'</div>':"")+
    '</div>'+
    '<div class="post-side">'+
      '<div><span class="num">'+(it.stats.replies||0)+'</span><div class="lbl">回复</div></div>'+
      '<div><span class="num">'+(it.stats.views||0)+'</span><div class="lbl">浏览</div></div>'+
      '<div><span class="num">'+(it.stats.likes||0)+'</span><div class="lbl">赞</div></div>'+
    '</div></div>';
}

/* ===== M3 概览 ===== */
function renderOverview(){
  const items = Store.items();
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const acts = items.filter(i => i.activity && isActiveSource(i) && !isEndedTitle(i.title));
  const running = acts.filter(i => actStatus(i.activity)==="running");
  const upcoming = acts.filter(i => actStatus(i.activity)==="upcoming");
  const todayNew = items.filter(i => {
    const t = new Date(i.created).getTime();
    return t >= today0;
  });

  $("#ovStats").innerHTML = [
    [running.length, "进行中活动", "y"],
    [upcoming.length, "即将开始", "i"],
    [todayNew.length, "今日新增动态", "g"],
    [items.length, "已收录条目", ""]
  ].map(s => '<div class="stat"><div class="v" style="color:'+
    (s[2]==="y"?"var(--accent)":s[2]==="i"?"var(--info)":s[2]==="g"?"var(--ok)":"var(--ink)")+'">'+s[0]+'</div><div class="k">'+s[1]+'</div></div>').join("");

  // 进行中（按截止升序） + 即将开始（按开始升序）
  const runningSorted = running.slice().sort((a,b) =>
    (a.activity.end?new Date(a.activity.end).getTime():Infinity) - (b.activity.end?new Date(b.activity.end).getTime():Infinity));
  const upcomingSorted = upcoming.slice().sort((a,b) =>
    (a.activity.start?new Date(a.activity.start).getTime():Infinity) - (b.activity.start?new Date(b.activity.start).getTime():Infinity));
  const sorted = runningSorted.concat(upcomingSorted).slice(0,8);
  $("#ovActs").innerHTML = sorted.length ? sorted.map(it => actCard(it)).join("")
    : '<div class="empty"><span class="big">(･_･;)</span>暂无活动数据，点击右上角「抓取最新」或手动录入</div>';

  // 论坛热点：近 7 天活跃，按 views*0.4+replies*3+likes*2 热度
  const hot = items.filter(i => i.source==="forum" && new Date(i.active).getTime() >= now.getTime()-7*24*3600*1000)
    .map(i => ({i, s:(i.stats.views||0)*0.4+(i.stats.replies||0)*3+(i.stats.likes||0)*2}))
    .sort((a,b)=>b.s-a.s).slice(0,6).map(x => x.i);
  $("#ovHot").innerHTML = hot.length ? hot.map(it => postCard(it)).join("")
    : '<div class="empty"><span class="big">(・_・)</span>近 7 天暂无热点，去「论坛信息流」看看吧</div>';

  // 最近动态（抓取日志 + 最近新增）
  const log = Store.data.log || [];
  const recent = items.slice().sort((a,b)=>new Date(b.created).getTime()-new Date(a.created).getTime()).slice(0,6);
  $("#ovLogSub").textContent = log.length ? "最近抓取/操作记录" : "数据动态";
  let html = '<div style="display:grid;gap:6px">';
  html += log.slice(0,5).map(l =>
    '<div style="display:flex;gap:10px;align-items:center;font:600 11.5px/1.5 var(--mono);color:var(--muted)">'+
    '<span style="color:var(--dim)">'+fmtDT(l.t)+'</span><span>'+esc(l.msg)+'</span>'+
    (l.add!==undefined?'<span class="badge g">+'+l.add+' 新增</span>':"")+
    (l.upd?'<span class="badge">'+l.upd+' 更新</span>':"")+'</div>').join("");
  html += '</div>';
  if(recent.length) html += '<div style="margin-top:12px;font:700 11px/1.4 var(--mono);color:var(--dim);letter-spacing:.5px">最近新增条目</div><div style="margin-top:6px;display:grid;gap:6px">'+
    recent.map(i => '<div style="display:flex;gap:8px;align-items:center;font:12.5px/1.5 var(--sans)">'+
      '<span class="badge">'+esc(i.source==="forum"?"论坛":i.source==="feishu"?"飞书":"手动")+'</span>'+
      '<a href="#" style="color:var(--text);font-weight:600" onclick="event.preventDefault();openDetail(Store.byId(\''+i.id+'\'))">'+esc(i.title)+'</a>'+
      '<span style="margin-left:auto;color:var(--dim);font:600 10.5px/1.4 var(--mono)">'+relTime(i.created)+'</span></div>').join("")+'</div>';
  $("#ovLog").innerHTML = html;
}

/* ===== M4 活动时间线 / 日历 ===== */
function tlFiltered(){
  const q = ($("#tlQ").value||"").trim().toLowerCase();
  let list = Store.items().filter(i => i.activity && isActiveSource(i) && !isEndedTitle(i.title));
  if(state.tlStatus) list = list.filter(i => actStatus(i.activity)===state.tlStatus);
  if(state.tlSrc) list = list.filter(i => i.source===state.tlSrc);
  if(q) list = list.filter(i => (i.title+" "+i.excerpt+" "+(i.activity.requirement||"")).toLowerCase().includes(q));
  return list.sort((a,b) => {
    const ae = a.activity.end||a.activity.start, be = b.activity.end||b.activity.start;
    return (ae?new Date(ae).getTime():Infinity) - (be?new Date(be).getTime():Infinity);
  });
}
function renderTimeline(){
  const list = tlFiltered();
  $("#tlList").innerHTML = list.length ? list.map(it => actCard(it)).join("")
    : '<div class="empty"><span class="big">(￣▽￣;)</span>没有匹配的活动，换个筛选条件试试</div>';
  renderCal();
}
function renderCal(){
  const y = state.calYear, mo = state.calMonth;
  $("#calTitle").textContent = y+" 年 "+(mo+1)+" 月";
  const first = new Date(y, mo, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(y, mo+1, 0).getDate();
  const today = new Date();
  const todayKey = today.getFullYear()+"-"+today.getMonth()+"-"+today.getDate();
  // 活动颜色池（按活动 id 稳定分配）
  const calColors = ["#ffd84d","#58b6ff","#ff9f43","#22a06b","#ff625d","#ab8eff","#f472b6","#38bdf8","#a3e635","#fbbf24"];
  const colorMap = {};
  const monthStart = new Date(y, mo, 1), monthEnd = new Date(y, mo+1, 0);
  // 收集该月活动（开始→截止跨天区间）
  const acts = Store.items().filter(i => i.activity && isActiveSource(i) && !isEndedTitle(i.title) && (i.activity.start||i.activity.end));
  const byDate = {};
  for(const it of acts){
    if(!colorMap[it.id]) colorMap[it.id] = calColors[Object.keys(colorMap).length % calColors.length];
    const a = it.activity;
    const s = a.start?new Date(a.start):null, e = a.end?new Date(a.end):null;
    // 完全在当月之外的活动跳过（结束早于月首，或开始晚于月末）
    if(e && e < monthStart) continue;
    if(s && s > monthEnd) continue;
    const rs = s && s < monthStart ? monthStart : s;   // 区间起点（截到月内）
    const re = e && e > monthEnd ? monthEnd : e;        // 区间终点（截到月内）
    if(!rs && !re) continue;
    const startD = rs ? rs.getDate() : 1;
    const endD = re ? re.getDate() : daysInMonth;
    for(let d = startD; d <= endD; d++){
      (byDate[d] = byDate[d] || []).push(it);
    }
  }
  let html = '<div class="cw">日</div><div class="cw">一</div><div class="cw">二</div><div class="cw">三</div><div class="cw">四</div><div class="cw">五</div><div class="cw">六</div>';
  for(let i=0;i<startDow;i++) html += '<div class="cd-cell other"></div>';
  for(let d=1;d<=daysInMonth;d++){
    const key = y+"-"+mo+"-"+d;
    const isToday = key === todayKey;
    const evs = byDate[d] || [];
    const seen = new Set();
    const unique = evs.filter(e => { if(seen.has(e.id)) return false; seen.add(e.id); return true; });
    html += '<div class="cd-cell'+(isToday?" today":"")+'">'+
      '<div class="d">'+d+'</div>'+
      unique.slice(0,4).map(ev => {
        const c = colorMap[ev.id] || calColors[0];
        const st = actStatus(ev.activity);
        return '<div class="ev'+(st==="ended"?" end":"")+'" style="border-left-color:'+c+';background:'+c+'1f" title="'+esc(ev.title)+'" onclick="openDetail(Store.byId(\''+ev.id+'\'))">'+esc(ev.title.slice(0,12))+'</div>';
      }).join("")+
      (unique.length>4?'<div class="ev" style="opacity:.6">+'+(unique.length-4)+'</div>':"")+
    '</div>';
  }
  $("#calGrid").innerHTML = html;
  // 图例
  const legendIds = Object.keys(colorMap);
  const prev = document.getElementById("calLegend");
  if(prev) prev.remove();
  if(legendIds.length){
    let lHtml = '<div id="calLegend" style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;font:600 10px/1.4 var(--mono);color:var(--dim)">';
    for(const id of legendIds.slice(0,12)){
      const it = Store.byId(id);
      if(!it) continue;
      lHtml += '<span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;display:inline-block;background:'+colorMap[id]+'"></span>'+esc(it.title.slice(0,20))+'</span>';
    }
    lHtml += '</div>';
    const legend = document.createElement("div");
    legend.innerHTML = lHtml;
    document.getElementById("calGrid").after(legend.firstChild);
  }
}

/* ===== M5 论坛信息流 ===== */
function renderFeed(){
  const q = ($("#fdQ").value||"").trim().toLowerCase();
  const cat = state.feedCat, kind = $("#fdKind").value, sort = state.feedSort;
  const allCats = CFG.actCats.concat(CFG.feedCats);
  let list = Store.items().filter(i => i.source==="forum");
  if(cat) list = list.filter(i => i.catId === +cat);
  else {
    // 默认只看常驻板块（官方活动 + 干货三板块）
    const ids = allCats.map(c=>c.id);
    list = list.filter(i => ids.includes(i.catId));
  }
  if(kind==="official") list = list.filter(i => i.flags.official);
  if(kind==="partner") list = list.filter(i => !i.flags.official);
  if(q) list = list.filter(i => (i.title+" "+i.excerpt+" "+(i.author||"")).toLowerCase().includes(q));
  list = list.slice().sort((a,b) => {
    if(sort==="created") return new Date(b.created) - new Date(a.created);
    if(sort==="hot") return ((b.stats.views||0)*0.4+(b.stats.replies||0)*3+(b.stats.likes||0)*2) - ((a.stats.views||0)*0.4+(a.stats.replies||0)*3+(a.stats.likes||0)*2);
    return new Date(b.active) - new Date(a.active);
  });
  $("#fdList").innerHTML = list.length ? list.map(it => postCard(it)).join("")
    : '<div class="empty"><span class="big">(･ω･)</span>暂无内容。点击右上角「抓取最新」拉取论坛动态</div>';
}

/* ===== M6 全局检索 ===== */
function renderSearch(){
  const q = ($("#srQ").value||"").trim().toLowerCase();
  const src = $("#srSrc").value, kind = $("#srKind").value, cat = $("#srCat").value, st = $("#srSt").value;
  let list = Store.items().slice();
  if(src) list = list.filter(i => i.source===src);
  if(kind) list = list.filter(i => i.kind===kind);
  if(cat) list = list.filter(i => i.catId === +cat);
  if(st) list = list.filter(i => i.activity && actStatus(i.activity)===st);
  if(q) list = list.filter(i =>
    (i.title+" "+(i.excerpt||"")+" "+(i.content||"")+" "+(i.tags||[]).join(" ")+" "+(i.author||"")).toLowerCase().includes(q));
  list = list.sort((a,b) => new Date(b.active||b.created) - new Date(a.active||a.created));
  const box = $("#srResult");
  if(!list.length){ box.innerHTML = '<div class="empty"><span class="big">(´･_･`)</span>没有找到匹配内容</div>'; return; }
  if(state.srView==="table"){
    box.innerHTML = '<table class="tbl"><thead><tr><th>来源</th><th>标题</th><th>类型</th><th>板块</th><th>作者</th><th>活跃</th></tr></thead><tbody>'+
      list.map(i => '<tr><td>'+esc(i.source==="forum"?"论坛":i.source==="feishu"?"飞书":"手动")+'</td>'+
        '<td><span class="tt" onclick="openDetail(Store.byId(\''+i.id+'\'))">'+esc(i.title)+'</span></td>'+
        '<td>'+({activity:"活动",notice:"公告",welfare:"福利",share:"伙伴分享",help:"求助",other:"其他"}[i.kind]||"-")+'</td>'+
        '<td>'+esc(i.category||"-")+'</td><td>'+esc(i.author||"-")+'</td><td style="white-space:nowrap">'+relTime(i.active)+'</td></tr>').join("")+
      '</tbody></table>';
  } else {
    box.innerHTML = list.map(i => postCard(i)).join("");
  }
}

/* ===== 数据管理 ===== */
function renderManage(){
  const items = Store.items().slice().sort((a,b)=>new Date(b.created)-new Date(a.created));
  $("#mgBody").innerHTML = items.map(i =>
    '<tr><td><span class="badge '+(i.source==="forum"?"o":i.source==="feishu"?"i":"g")+'">'+
      esc(i.source==="forum"?"论坛":i.source==="feishu"?"飞书":"手动")+'</span></td>'+
      '<td><span class="tt" onclick="openDetail(Store.byId(\''+i.id+'\'))">'+esc(i.title)+'</span></td>'+
      '<td>'+esc(i.category||"-")+'</td><td>'+esc(i.author||"-")+'</td>'+
      '<td style="white-space:nowrap">'+fmtDate(i.created)+'</td>'+
      '<td><button class="icon" title="删除" onclick="delItem(\''+i.id+'\')" style="width:26px;height:26px;min-height:26px">×</button></td></tr>').join("") ||
    '<tr><td colspan="6" style="text-align:center;color:var(--dim)">暂无数据</td></tr>';
}
function delItem(id){
  if(!confirm("确认删除该条目？")) return;
  Store.remove(id);
  Store.logPush({t:new Date().toISOString(), msg:"删除条目 "+id});
  Store.save(); refreshDataStat(); renderAll();
  toast("已删除","ok");
}

function renderAll(){
  refreshDataStat();
  renderOverview();
  renderTimeline();
  renderFeed();
  renderSearch();
  renderManage();
}

init();
