(() => {
  if (window.__douyinVideoSheetObserver) return;
  window.__douyinVideoSheetObserver = true;
  const CHANNEL = "DOUYIN_VIDEO_SHEET_V1";
  const cache = [];
  let lastRequestStamp=0;
  const requestStamp=()=>lastRequestStamp=Math.max(Date.now(),lastRequestStamp+1);
  function emit(payload) {
    if (["video", "comments", "rendered-comments"].includes(payload.type)) {
      const index = cache.findIndex(p => p.type === payload.type && (payload.type === "video" ? p.video.id === payload.video.id : p.videoId === payload.videoId && (payload.type !== "comments" || (p.requestCursor === payload.requestCursor && p.streamKey === payload.streamKey))));
      if (index >= 0) {
        if(payload.type==="comments" && (cache[index].observedAt||0)>(payload.observedAt||0)) return;
        if (payload.type === "video") {
          const video={ ...cache[index].video, ...Object.fromEntries(Object.entries(payload.video).filter(([, value]) => value != null && value !== "")) };
          for (const key of ["mediaUrls","audioUrls"]) video[key]=[...new Set([...(payload.video[key] || []),...(cache[index].video[key] || [])])].slice(0,20);
          payload={...payload,video};
        }
        if (payload.type === "rendered-comments") {
          // Virtualized rows disappear from the DOM. Keep the confirmed rows
          // available for a later bridge resync as well as for the live reader.
          const rows = new Map(cache[index].comments.map(row => [row.id, row]));
          for (const row of payload.comments) rows.set(row.id, row);
          payload = { ...payload, comments: [...rows.values()].slice(0, 10000) };
        }
        cache.splice(index, 1);
      }
    }
    cache.push(payload);
    if (cache.length > 120) cache.shift();
    window.postMessage({ channel: CHANNEL, kind: "observed", payload }, location.origin);
  }
  function validMedia(url) {
    try {
      const u = new URL(url, location.href);
      return u.protocol === "https:" && /(^|\.)(douyinvod\.com|douyin\.com|bytecdn\.cn|byteimg\.com)$/.test(u.hostname);
    } catch { return false; }
  }
  function validCover(url) {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") &&
        /(^|\.)(douyinpic\.com|byteimg\.com|bytecdn\.cn|douyin\.com|pstatp\.com)$/.test(u.hostname);
    } catch { return false; }
  }
  function coverUrls(value, depth = 0) {
    if (!value || depth > 4) return [];
    if (typeof value === "string") return validCover(value) ? [value] : [];
    if (Array.isArray(value)) return value.slice(0, 20).flatMap(item => coverUrls(item, depth + 1));
    return ["url_list", "urlList", "src", "url", "display_image", "displayImage", "origin_image", "originImage", "image_url", "imageUrl"].flatMap(key => coverUrls(value[key], depth + 1));
  }
  function parseVideo(item) {
    const id = item?.aweme_id || item?.awemeId;
    if (!/^\d+$/.test(String(id || ""))) return;
    const stats = item.statistics || item.stats || item.statistic || {};
    const author = item.author || item.authorInfo || item.author_info || {};
    const images = item.images || item.image_post_info?.images || item.imagePostInfo?.images || [];
    const video = item.video || {};
    const count = value => /^\d+$/.test(String(value ?? "")) ? Number(value) : null;
    function urls(value,depth=0) {
      if (depth>5 || !value) return [];
      if (typeof value==="string") return validMedia(value) ? [value] : [];
      if (Array.isArray(value)) return value.slice(0,100).flatMap(v=>urls(v,depth+1));
      return ["src","url","url_list","urlList","play_addr","playAddr"].flatMap(key=>urls(value[key],depth+1));
    }
    // DASH video and audio are separate. Only take the video's own audio
    // renditions; item.music is background music and must never substitute speech.
    const audioUrls=[...new Set(urls(video.bit_rate_audio || video.bit_rate_audio_list || video.bitRateAudioList || video.bitRateAudio || []))].slice(0,10);
    const rawRates=video.bit_rate || video.bitRate || video.bitRateList || [];
    const rates=Array.isArray(rawRates) ? rawRates : [];
    const mediaUrls = [...new Set([
      ...audioUrls,...urls(video.play_addr || video.playAddr),
      ...urls(video.play_addr_h264 || video.playAddrH264),
      ...rates.filter(b=>(b.format || b.videoFormat)!=="dash").flatMap(b=>urls(b)),
      ...urls(video.download_addr || video.downloadAddr),...urls(video.playApi),
      ...rates.filter(b=>(b.format || b.videoFormat)==="dash").flatMap(b=>urls(b))
    ])].slice(0,20);
    emit({ type: "video", video: {
      id: String(id), url: `https://www.douyin.com/${images.length || item.image_post_info || item.imagePostInfo ? "note" : "video"}/${id}`, title: String(item.desc || item.title || item.shareInfo?.shareTitle || ""), author: String(author.nickname || author.nickName || author.name || ""),
      likes: count(stats.digg_count ?? stats.diggCount ?? item.digg_count ?? item.diggCount), commentCount: count(stats.comment_count ?? stats.commentCount ?? item.comment_count ?? item.commentCount),
      collectCount: count(stats.collect_count ?? stats.collectCount ?? item.collect_count ?? item.collectCount), shareCount: count(stats.share_count ?? stats.shareCount ?? item.share_count ?? item.shareCount),
      createdAt: item.create_time || item.createTime || null, duration: video.duration ? video.duration / 1000 : null,
      coverUrl: [video.origin_cover, video.originCover, video.cover, video.dynamic_cover, video.dynamicCover, item.cover, item.coverUrl, images[0]].flatMap(value => coverUrls(value))[0] || "",
      mediaUrls, audioUrls, metricsSource: "页面数据"
    }});
  }
  function inspectObject(data, limit = 20000, maxDepth = 15, onlyId = "") {
    let visited = 0;
    const seen = new WeakSet();
    function walk(value, depth) {
      if (!value || typeof value !== "object" || depth > maxDepth || ++visited > limit || seen.has(value)) return;
      seen.add(value);
      const id = String(value.aweme_id || value.awemeId || "");
      if (id && (!onlyId || id === onlyId) && (value.video || value.statistics || value.stats || value.statistic || value.images || value.image_post_info || value.imagePostInfo)) parseVideo(value);
      for (const [key, child] of Object.entries(value)) {
        if (!/token|cookie|password|session|authorization|^children$|^_owner$|^return$/i.test(key)) walk(child, depth + 1);
      }
    }
    walk(data, 0);
  }
  function inspect(rawUrl, data,startedAt) {
    try {
      const url = new URL(rawUrl, location.href);
      if (url.hostname !== "www.douyin.com" || !url.pathname.startsWith("/aweme/")) return;
      inspectObject(data);
      if (!/\/comment\/list\/?$/.test(url.pathname) || !Array.isArray(data?.comments) || (data.status_code != null && Number(data.status_code) !== 0)) return;
      const videoId = url.searchParams.get("aweme_id") || data.comments[0]?.aweme_id;
      if (!/^\d+$/.test(String(videoId || ""))) return;
      const streamKey = url.pathname + JSON.stringify(["sort_type", "sort", "order", "filter_type", "type"].map(key => [key, url.searchParams.get(key) || ""]));
      const observedAt = startedAt || requestStamp();
      const consistent=data.comments.every(c=>!(c.aweme_id || c.awemeId) || String(c.aweme_id || c.awemeId)===String(videoId));
      emit({ type: "comments", videoId: String(videoId), streamKey,observedAt, unfiltered: consistent && !["comment_id", "cid", "keyword", "search_keyword"].some(key => url.searchParams.get(key)), requestCursor: url.searchParams.get("cursor") || "0",
        nextCursor: String(data.cursor ?? ""), hasMore: data.has_more, total: data.total ?? null,
        truncated: data.comments.length > 1000,
        comments: data.comments.slice(0, 1000).filter(c=>!(c.aweme_id || c.awemeId) || String(c.aweme_id || c.awemeId)===String(videoId)).map(c => ({
          id: String(c.cid || ""), text: String(c.text || ""), likes: c.digg_count ?? null,
          author: String(c.user?.nickname || ""), createdAt: c.create_time || null,
          isReply: Boolean(c.reply_id && String(c.reply_id) !== "0"), source: "api", approximate: false, observedAt,videoId:String(videoId),ownerVerified:true
        }))
      });
    } catch { /* An observer must never interrupt playback. */ }
  }
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const startedAt=requestStamp();
    const promise = Reflect.apply(originalFetch, this, args);
    promise.then(response => {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || args[0]?.href;
      if (String(url).includes("/aweme/")) response.clone().json().then(data => inspect(url, data,startedAt)).catch(() => {});
    }).catch(() => {});
    return promise;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const urls = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    urls.set(this, String(url));
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const startedAt=requestStamp();
    if ((urls.get(this) || "").includes("/aweme/")) this.addEventListener("load", () => {
      try { inspect(urls.get(this), this.responseType === "json" ? this.response : JSON.parse(this.responseText),startedAt); } catch {}
    }, { once: true });
    return Reflect.apply(originalSend, this, args);
  };
  function inspectEmbedded() {
    for (const el of document.querySelectorAll('script#RENDER_DATA,script#__NEXT_DATA__,script[type="application/json"]')) {
      try {
        const raw = el.textContent || "";
        if (raw.length > 12e6) continue;
        const data = JSON.parse(raw.startsWith("%") ? decodeURIComponent(raw) : raw);
        inspectObject(data);
      } catch {}
    }
    // Router hydration may already have run before a resync. No script eval.
    const id = location.pathname.match(/^\/note\/(\d+)/)?.[1];
    if (id) for (const value of [window._ROUTER_DATA, window.__INITIAL_STATE__, window.__NEXT_DATA__]) {
      try { if (value && typeof value === "object") inspectObject(value, 20000, 15, id); } catch {}
    }
  }
  function inspectRenderedVideo() {
    // Recover public video props already rendered by React when its fetch was
    // made before the observer attached. Read only the visible video ancestry.
    for (const video of [...document.querySelectorAll("video")].filter(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).slice(0, 3)) {
      let node = video;
      for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
        for (const key of Object.keys(node).filter(k => k.startsWith("__reactProps$") || k.startsWith("__reactFiber$"))) {
          const value = node[key];
          if (key.startsWith("__reactProps$")) inspectObject(value, 2500, 8);
          else {
            let fiber = value;
            for (let parent = 0; fiber && parent < 10; parent++, fiber = fiber.return) inspectObject(fiber.memoizedProps, 2500, 8);
          }
        }
      }
    }
  }
  function inspectRenderedNote() {
    const id = location.pathname.match(/^\/note\/(\d+)/)?.[1];
    if (!id) return;
    const visible = el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    // A note has images instead of <video>. Recover the existing page's public
    // React data, always requiring its explicit aweme ID to match this URL.
    const owned = document.querySelector(`[data-aweme-id="${id}"],[data-video-id="${id}"]`);
    let scopes = owned ? [owned] : [...document.querySelectorAll('main,[role="main"],[data-e2e="note-detail"],[data-e2e="aweme-detail"]')].filter(visible).slice(0, 3);
    if (!scopes.length) scopes = [document.querySelector('#root,#app') || document.body].filter(Boolean);
    const seenNodes = new Set(), seenProps = new WeakSet();
    let inspected = 0;
    function read(props) {
      if (!props || typeof props !== "object" || seenProps.has(props) || inspected++ >= 60) return;
      seenProps.add(props); inspectObject(props, 2500, 10, id);
    }
    for (const scope of scopes) {
      const seeds = [scope, ...scope.querySelectorAll('img,picture,[data-e2e*="author"],[data-e2e*="note"],[data-e2e*="image"]')].filter(visible).slice(0, 30);
      for (const seed of seeds) {
        if (seed.closest('[data-e2e*="comment"],[data-comment-id],aside')) continue;
        let node = seed;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
          if (seenNodes.has(node)) break;
          seenNodes.add(node);
          for (const key of Object.keys(node).filter(k => k.startsWith("__reactProps$") || k.startsWith("__reactFiber$"))) {
            if (key.startsWith("__reactProps$")) read(node[key]);
            else for (let fiber = node[key], n = 0; fiber && n < 12; fiber = fiber.return, n++) read(fiber.memoizedProps);
          }
          if (node === document.body) break;
        }
      }
    }
  }
  function inspectRenderedComments() {
    const u = new URL(location.href), videoId = u.pathname.match(/\/(?:video|note)\/(\d+)/)?.[1] || u.searchParams.get("modal_id") || u.searchParams.get("aweme_id");
    if (!/^\d+$/.test(videoId || "")) return;
    const comments = new Map();
    let visited = 0;
    function contextOwner(props) {
      // These are the video's props on the SAME comment component. A sibling
      // awemeInfo owns commentInfo, although commentInfo has no awemeId itself.
      return String(props?.aweme_id || props?.awemeId || props?.awemeInfo?.aweme_id || props?.awemeInfo?.awemeId || props?.awemeInfo?.awemeInfo?.aweme_id || props?.awemeInfo?.awemeInfo?.awemeId || "");
    }
    function walk(value, depth = 0,parentOwner="",seen=new WeakSet()) {
      if (!value || typeof value !== "object" || depth > 8 || ++visited > 10000 || seen.has(value)) return;
      seen.add(value);
      const id = value.cid || value.commentId;
      const likes = value.digg_count ?? value.diggCount;
      const explicitOwner=contextOwner(value);
      if (explicitOwner && parentOwner && explicitOwner!==parentOwner) return;
      const owner = explicitOwner || parentOwner;
      if (id && typeof value.text === "string" && /^\d+$/.test(String(likes ?? "")) && owner === videoId) {
        const reply = value.reply_id || value.replyId;
        if ((!reply || String(reply) === "0") && value.text.trim()) comments.set(String(id), { id: String(id), text: value.text, likes: Number(likes), author: value.user?.nickname || value.user?.nickName || "", createdAt: value.create_time || value.createTime || null, isReply: false, source: "page", approximate: false,videoId,ownerVerified:true,observedAt:Date.now() });
      }
      if (id && typeof value.text === "string") return;
      for (const [key, child] of Object.entries(value)) if (!/reply|replies|token|cookie|password|session|^children$|^_owner$|^return$|^commentList$|^awemeInfo$/i.test(key)) walk(child, depth + 1,owner,seen);
    }
    for (const node of [...document.querySelectorAll('[data-e2e="comment-item"],[data-comment-id]')].slice(0, 250)) {
      if (!node.getBoundingClientRect().width || node.closest('[data-e2e="comment-reply-list"],[data-e2e="comment-reply-item"],[data-e2e="reply-list"]')) continue;
      const ownerNode=node.closest('[data-aweme-id],[data-video-id]');
      const owner=ownerNode?.getAttribute("data-aweme-id") || ownerNode?.getAttribute("data-video-id") || "";
      for (const key of Object.keys(node).filter(k => k.startsWith("__reactProps$") || k.startsWith("__reactFiber$"))) {
        if (key.startsWith("__reactProps$")) { walk(node[key],0,owner); continue; }
        // The host div has only className/children. The parent component has
        // commentInfo + awemeInfo. Stop at that component, including replies,
        // instead of reading an unrelated ancestor's comment list.
        let fiber=node[key];
        for (let parent=0; fiber && parent<12; parent++,fiber=fiber.return) {
          const props=fiber.memoizedProps;
          if (!props || typeof props!=="object") continue;
          if (props.commentInfo) { walk(props.commentInfo,0,contextOwner(props) || owner); break; }
          if (props.comment) { walk(props.comment,0,contextOwner(props) || owner); break; }
          if (parent===0) walk(props,0,owner);
        }
      }
    }
    if (comments.size) emit({ type: "rendered-comments", videoId, comments: [...comments.values()] });
  }
  let lastRecovery = 0;
  // Read each mounted batch before React replaces it with another ranked page.
  // This runs even before the user opens the extension's workbench.
  let renderPending=false;
  const renderObserver=new MutationObserver(records=>{
    const relevant=records.some(record=>(record.target.nodeType===1 ? record.target : record.target.parentElement)?.closest?.('[data-e2e="comment-list"],[data-e2e="comment-item"],[data-comment-id]') || [...record.addedNodes].some(node=>node.nodeType===1 && (node.matches?.('[data-e2e="comment-list"],[data-e2e="comment-item"],[data-comment-id]') || node.querySelector?.('[data-e2e="comment-item"],[data-comment-id]'))));
    if (!relevant || renderPending) return;
    renderPending=true;
    queueMicrotask(()=>{renderPending=false;inspectRenderedComments();});
  });
  renderObserver.observe(document,{childList:true,subtree:true,characterData:true});
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL || event.data.kind !== "resync") return;
    for (const payload of cache) window.postMessage({ channel: CHANNEL, kind: "observed", payload }, location.origin);
    if (Date.now() - lastRecovery > 2000) {
      lastRecovery = Date.now(); inspectEmbedded(); inspectRenderedVideo(); inspectRenderedNote(); inspectRenderedComments();
    }
  });
  document.addEventListener("DOMContentLoaded",()=>{inspectEmbedded();inspectRenderedNote();inspectRenderedComments();}, { once: true });
})();
