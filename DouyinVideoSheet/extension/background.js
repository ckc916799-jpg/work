import { parseDouyinLink } from "./video-links.mjs";
let batchTabId = null;
chrome.action.onClicked.addListener(async (tab) => {
  const url = new URL(chrome.runtime.getURL("workspace.html"));
  if (tab.id && /^https:\/\/www\.douyin\.com\//.test(tab.url || "")) url.searchParams.set("tab", tab.id);
  await chrome.tabs.create({ url: url.href });
});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if (sender.id!==chrome.runtime.id || message.type!=="SHEET_OPEN_LINK") return;
  (async()=>{
    const parsed=parseDouyinLink(message.value);
    if (message.batch) {
      let tab=null;
      const reusableId = Number(message.reuseTabId) || batchTabId;
      if (reusableId) {
        try { tab=await chrome.tabs.update(reusableId,{url:parsed.url,active:false}); } catch { batchTabId=null; }
      }
      if (!tab) tab=await chrome.tabs.create({url:parsed.url,active:false});
      batchTabId=tab.id;
      respond({ok:true,tabId:tab.id,videoId:parsed.id});
      return;
    }
    const candidates=parsed.id ? await chrome.tabs.query({url:"https://www.douyin.com/*"}) : [];
    const existing=candidates.find(tab=>{
      try { const u=new URL(tab.url);return (u.pathname.match(/\/video\/(\d+)/)?.[1] || u.searchParams.get("modal_id") || u.searchParams.get("aweme_id"))===parsed.id; } catch { return false; }
    });
    let tab=existing;
    if (tab) {
      try {
        const response=await Promise.race([chrome.tabs.sendMessage(tab.id,{type:"SHEET_STATE"}),new Promise((_,reject)=>setTimeout(()=>reject(new Error("Page not ready")),2000))]);
        if (!response?.ok || response.state?.video?.id!==parsed.id) tab=null;
      } catch { tab=null; }
    }
    // A page opened before installation may have no content script. Open a new
    // one instead of reloading the user's existing tab or silently failing.
    tab=tab || await chrome.tabs.create({url:parsed.url,active:false});
    respond({ok:true,tabId:tab.id,videoId:parsed.id});
  })().catch(err=>respond({ok:false,error:err.message}));
  return true;
});
