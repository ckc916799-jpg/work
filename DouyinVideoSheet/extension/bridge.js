(() => {
  const CHANNEL = "DOUYIN_VIDEO_SHEET_V1";
  const videos = new Map();
  let capture = null;
  let watchedId = "";
  function currentId() {
    const u = new URL(location.href);
    return u.pathname.match(/\/(?:video|note)\/(\d+)/)?.[1] || u.searchParams.get("modal_id") || u.searchParams.get("aweme_id") || "";
  }
  function bucket(id) {
    if (!videos.has(id)) {
      if (videos.size >= 25) {
        const protectedIds=new Set([currentId(),watchedId,capture?.id]);
        const evict=[...videos.keys()].find(key=>!protectedIds.has(key));
        if(evict) videos.delete(evict);
      }
      videos.set(id, { video: { id, mediaUrls: [] }, comments: new Map(), streams: new Map(), stopReason: "", progress: "" });
    }
    return videos.get(id);
  }
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL || event.data.kind !== "observed") return;
    const p = event.data.payload;
    if (!p || typeof p !== "object") return;
    if (p.type === "video" && /^\d+$/.test(p.video?.id)) {
      const b = bucket(p.video.id);
      // Later responses can omit statistics: never erase an earlier known count
      // with null, and never downgrade exact API counts to visible abbreviations.
      for (const [key, value] of Object.entries(p.video)) {
        if (value == null || value === "") continue;
        if (["likes", "commentCount", "collectCount", "shareCount"].includes(key)) {
          const number = parseCount(value); if (number == null) continue;
          b.video[key] = number; b.video.metricsApproximate = { ...b.video.metricsApproximate, [key]: false };
        } else if (["mediaUrls","audioUrls"].includes(key)) b.video[key] = [...new Set([...(Array.isArray(value) ? value : []), ...(b.video[key] || [])])].slice(0, 20);
        else b.video[key] = value;
      }
    } else if (["comments", "rendered-comments"].includes(p.type) && /^\d+$/.test(p.videoId) && Array.isArray(p.comments)) {
      const b = bucket(p.videoId);
      if (b.video.commentCount == null && parseCount(p.total) != null) b.video.commentCount = parseCount(p.total);
      const previousSize = b.comments.size;
      const streamKey = p.streamKey || "default";
      if (p.type === "comments" && !b.streams.has(streamKey)) b.streams.set(streamKey, new Map());
      const pages = b.streams.get(streamKey);
      const newPage = p.type === "comments" && !pages.has(String(p.requestCursor));
      for (const c of p.comments) {
        const likes=parseCount(c.likes);
        if (!c.id || typeof c.text !== "string" || !c.text.trim() || c.isReply || likes==null || (c.videoId && String(c.videoId)!==p.videoId)) continue;
        if (p.type==="rendered-comments" && (!c.ownerVerified || c.videoId!==p.videoId)) continue;
        if (!b.comments.has(c.id) && b.comments.size >= 10000) break;
        const prior = b.comments.get(c.id);
        if (p.type === "comments" ? !prior || prior.source !== "api" || (c.observedAt || 0) >= (prior.observedAt || 0) : prior?.source !== "api") b.comments.set(c.id, {...c,likes,videoId:p.videoId,ownerVerified:true});
      }
      const observedAt=p.observedAt ?? Math.max(0,...p.comments.map(c=>Number(c.observedAt)||0));
      if (p.type === "comments" && observedAt>=(pages.get(String(p.requestCursor))?.observedAt||0)) pages.set(String(p.requestCursor), { observedAt,next: String(p.nextCursor), more: p.truncated ? true : p.hasMore,
        rankable: p.unfiltered !== false && !p.truncated && !(String(p.requestCursor) === "0" && !p.comments.length && (Number(p.total) > 0 || b.video.commentCount > 0 || b.comments.size>0)) && p.comments.every(c => c.isReply || (c.id && c.text && parseCount(c.likes) != null && (!c.videoId || c.videoId===p.videoId))) });
      if (capture?.id === p.videoId && (newPage || b.comments.size > previousSize)) capture.lastPageAt = Date.now();
    }
  });
  function chainComplete(b) {
    for (const pages of b.streams.values()) {
      let cursor = "0";
      const seen = new Set();
      while (pages.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor);
        const page = pages.get(cursor);
        if (!page.rankable) break;
        if (page.more === 0 || page.more === false) return true;
        cursor = page.next;
      }
    }
    return false;
  }
  function visible(el) {
    return !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  }
  function parseCount(value) {
    const m = String(value ?? "").replace(/[,，\s]/g, "").match(/^(\d+(?:\.\d+)?)([万亿wWkKmM]?)\+?$/);
    if (!m) return null;
    const count=Math.round(Number(m[1]) * ({万: 1e4, 亿: 1e8, w: 1e4, W: 1e4, k: 1e3, K: 1e3, m: 1e6, M: 1e6}[m[2]] || 1));
    return Number.isSafeInteger(count) && count>=0 ? count : null;
  }
  function rootPanel() {
    const candidates = [...document.querySelectorAll('[data-e2e="comment-list"],[data-e2e="comment-list-container"],[data-e2e="comment-panel"],[data-e2e="comment-list-wrapper"],[data-e2e="comment-list-scroll"],[data-e2e="comment-list-scroll-container"]')].filter(visible);
    if (candidates.length) return candidates.find(node => node.querySelector('[data-e2e="comment-item"],[data-comment-id]')) || candidates[0];
    const item = [...document.querySelectorAll('[data-e2e="comment-item"],[data-comment-id]')].find(node => visible(node) && !node.closest('[data-e2e="comment-reply-list"],[data-e2e="reply-list"]'));
    let parent = item?.parentElement;
    while (parent && parent !== document.body) {
      if (/auto|scroll|overlay/.test(getComputedStyle(parent).overflowY) && ![...parent.querySelectorAll("video")].some(visible)) return parent;
      parent = parent.parentElement;
    }
    return null;
  }
  function scrollPanel(root) {
    if (!root) return null;
    const scrollable = node => visible(node) && node.clientHeight > 60 && /auto|scroll|overlay/.test(getComputedStyle(node).overflowY);
    // Prefer the comment list inside its wrapper over the outer page scroller.
    const inside = [root, ...root.querySelectorAll("div,section,ul")].filter(scrollable);
    const populated = inside.filter(node => node.querySelector('[data-e2e="comment-item"],[data-comment-id]'));
    if (populated.length || inside.length) return (populated.length ? populated : inside).sort((a, b) => a.contains(b) ? 1 : b.contains(a) ? -1 : 0)[0];
    let node = root.parentElement;
    while (node && node !== document.body) {
      if (scrollable(node)) return node;
      node = node.parentElement;
    }
    return null;
  }
  function readDom(b, root) {
    if (!root) return;
    for (const item of root.querySelectorAll('[data-e2e="comment-item"],[data-comment-id]')) {
      if (item.closest('[data-e2e="comment-reply-list"],[data-e2e="comment-reply-item"],[data-e2e="reply-list"]')) continue;
      if (item.parentElement?.closest('[data-e2e="comment-item"],[data-comment-id]')) continue;
      const textEl = item.querySelector('[data-e2e="comment-content"],[data-e2e="comment-item-content"]');
      const nameEl = item.querySelector('[data-e2e="comment-username"],[data-e2e="comment-user-name"],a[href*="/user/"]');
      const likeEl = item.querySelector('[data-e2e="comment-like-count"],[data-e2e="comment-like"]');
      const rawLikes = likeEl?.textContent?.trim() || "";
      const likes = parseCount(rawLikes);
      const text = textEl?.textContent?.trim();
      if (!text || likes === null) continue;
      const id = item.getAttribute("data-comment-id") || item.getAttribute("data-id");
      const ownerNode=item.closest('[data-aweme-id],[data-video-id]');
      const owner=ownerNode?.getAttribute("data-aweme-id") || ownerNode?.getAttribute("data-video-id");
      // A stale panel can remain visible during navigation. Unknown ownership
      // is not evidence that the row belongs to the URL's current video.
      if (owner!==b.video.id) continue;
      // Rows without stable IDs are ignored: fabricated IDs can double-count API rows.
      if (!id || ["api", "page"].includes(b.comments.get(id)?.source)) continue;
      b.comments.set(id, { id, text, likes, author: nameEl?.textContent?.trim() || "匿名用户", source: "dom", approximate: /[万亿wWkKmM+]/.test(rawLikes), isReply: false,videoId:b.video.id,ownerVerified:true });
    }
  }
  function readMetrics(b) {
    const activeVideos = [...document.querySelectorAll("video")].filter(visible);
    const active = activeVideos.find(video => video.closest(`[data-aweme-id="${b.video.id}"],[data-video-id="${b.video.id}"]`)) || (activeVideos.length === 1 ? activeVideos[0] : null);
    let scope = document.querySelector(`[data-aweme-id="${b.video.id}"],[data-video-id="${b.video.id}"]`);
    const metricSelector = '[data-e2e*="like"],[data-e2e*="digg"],[data-e2e*="comment-icon"],[data-e2e*="collect"],[data-e2e*="share"]';
    if (!scope && active) {
      let parent = active.parentElement;
      while (parent && parent !== document.body) {
        if (parent.querySelector(metricSelector)) { scope = parent; break; }
        parent = parent.parentElement;
      }
    }
    // A detail URL with no feed cards has a single video source. Never use the
    // whole document for a multi-card feed, which could mix another video's likes.
    if (!scope && /\/(?:video|note)\/\d+/.test(location.pathname) && activeVideos.length <= 1 && document.querySelectorAll('[data-e2e="feed-item"]').length <= 1) scope = document.querySelector('main,[role="main"],[data-e2e="note-detail"],[data-e2e="aweme-detail"]') || document.body;
    if (!scope || !visible(scope)) return;
    const belongs = el => {
      if (!visible(el) || el.closest('[data-e2e*="comment"],[data-comment-id],aside,nav,footer,[data-e2e*="recommend"]')) return false;
      const link = el.closest('a[href*="/note/"],a[href*="/video/"]');
      if (link) {
        try { const linkedId = new URL(link.href,location.href).pathname.match(/\/(?:note|video)\/(\d+)/)?.[1]; if (linkedId && linkedId !== b.video.id) return false; } catch {}
      }
      const owner = el.closest('[data-aweme-id],[data-video-id]');
      return !owner || (owner.getAttribute("data-aweme-id") || owner.getAttribute("data-video-id")) === b.video.id;
    };
    const title = [...scope.querySelectorAll('[data-e2e="video-desc"],[data-e2e="video-title"]')].find(visible)?.textContent?.trim();
    if (!b.video.title && title) b.video.title = title;
    const author = [...scope.querySelectorAll('[data-e2e="video-author"],[data-e2e="feed-author-name"],[data-e2e="video-author-name"],[data-e2e="note-author"],[data-e2e="author-name"],[data-e2e="user-name"],a[href*="/user/"]')].find(belongs)?.textContent?.trim();
    if (!b.video.author && author) b.video.author = author.replace(/^@/, "");
    if (!b.video.coverUrl && location.pathname.startsWith("/note/")) {
      const images = [...scope.querySelectorAll('img')].filter(el => belongs(el) && el.getBoundingClientRect().width >= 160 && el.getBoundingClientRect().height >= 160 && !el.closest('a[href*="/user/"],[data-e2e*="avatar"]'));
      for (const image of images) {
        try {
          const u = new URL(image.currentSrc || image.src || image.getAttribute("data-src"), location.href);
          if (u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && /(^|\.)(douyinpic\.com|byteimg\.com|bytecdn\.cn|douyin\.com|pstatp\.com)$/.test(u.hostname)) { b.video.coverUrl = u.href; break; }
        } catch {}
      }
    }
    const controls = {
      likes: ['[data-e2e="video-like-count"]','[data-e2e="like-count"]','[data-e2e="feed-like-icon"]','[data-e2e="video-like-icon"]','[data-e2e="like-icon"]','[data-e2e="feed-digg-icon"]','[aria-label*="点赞"]'],
      commentCount: ['[data-e2e="video-comment-count"]','[data-e2e="feed-comment-icon"]','[data-e2e="video-comment-icon"]','[data-e2e="comment-icon"]','[aria-label*="评论"]'],
      collectCount: ['[data-e2e="video-collect-count"]','[data-e2e="feed-collect-icon"]','[data-e2e="video-collect-icon"]','[data-e2e="collect-icon"]','[aria-label*="收藏"]'],
      shareCount: ['[data-e2e="video-share-count"]','[data-e2e="feed-share-icon"]','[data-e2e="video-share-icon"]','[data-e2e="share-icon"]','[aria-label*="分享"]']
    };
    for (const [key, selectors] of Object.entries(controls)) {
      if (b.video[key] != null && !b.video.metricsApproximate?.[key]) continue;
      let found = null;
      const noteNames = {likes:"like|digg|点赞",commentCount:"comment|评论",collectCount:"collect|favorite|收藏",shareCount:"share|分享|转发"};
      const noteControls = location.pathname.startsWith("/note/") ? [...scope.querySelectorAll('button,[role="button"],[data-e2e],[aria-label],[title]')].filter(el => new RegExp(noteNames[key],"i").test([el.getAttribute("data-e2e"),el.getAttribute("aria-label"),el.getAttribute("title")].join(" "))) : [];
      for (const elements of [...selectors.map(selector => [...scope.querySelectorAll(selector)]), noteControls]) {
        for (const el of elements.filter(belongs)) {
          const candidates = [el.textContent, el.getAttribute("aria-label"), el.getAttribute("title"), ...[...el.querySelectorAll("span")].map(span => span.textContent)];
          // Icon-only controls often have the counter immediately beside them.
          if (!candidates.some(raw => parseCount(raw) != null) && el.parentElement && el.parentElement !== scope) candidates.push(el.parentElement.textContent);
          for (const raw of candidates) {
            const clean = String(raw || "").trim().replace(/^(已点赞|取消点赞|已收藏|取消收藏|点赞|评论|收藏|分享|转发)\s*[:：]?\s*/, "").replace(/\s*(点赞|评论|收藏|分享|转发|次)$/, "");
            const count = parseCount(clean);
            if (count != null) { found = { count, approximate: /[万亿wWkKmM+]/.test(clean) }; break; }
          }
          if (found) break;
        }
        if (found) break;
      }
      if (found) { b.video[key] = found.count; b.video.metricsApproximate = { ...b.video.metricsApproximate, [key]: found.approximate }; }
    }
  }
  function snapshot(id = currentId()) {
    id = id || currentId();
    if (!id) throw new Error("请在抖音打开某条视频的详情页，再点击插件。推荐地址：www.douyin.com/video/视频ID");
    const b = bucket(id);
    if (id === currentId()) {
      readDom(b, rootPanel());
      readMetrics(b);
      if (!b.video.title && /\/(?:video|note)\//.test(location.pathname)) {
        const pageTitle = (document.querySelector('meta[property="og:title"]')?.content || document.title || "").replace(/\s*[-_|｜]\s*抖音.*$/, "").trim();
        b.video.title = document.querySelector('meta[property="og:description"]')?.content || (/^抖音|记录美好生活/.test(pageTitle) ? "" : pageTitle);
      }
      if (!b.video.coverUrl && /\/(?:video|note)\/\d+/.test(location.pathname)) {
        const candidate = document.querySelector('meta[property="og:image"]')?.content || document.querySelector('video[poster]')?.poster;
        try {
          const u = new URL(candidate);
          if (u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && /(^|\.)(douyinpic\.com|byteimg\.com|bytecdn\.cn|douyin\.com|pstatp\.com)$/.test(u.hostname)) b.video.coverUrl = u.href;
        } catch {}
      }
      b.video.url = `https://www.douyin.com/${location.pathname.startsWith("/note/") ? "note" : "video"}/${id}`;
      const video = [...document.querySelectorAll("video")].find(visible);
      const src = video?.currentSrc || video?.src;
      if (src?.startsWith("https:")) {
        try {
          const u = new URL(src);
          if (/(^|\.)(douyinvod\.com|douyin\.com|bytecdn\.cn|byteimg\.com)$/.test(u.hostname)) b.video.mediaUrls = [...new Set([src, ...(b.video.mediaUrls || [])])];
        } catch {}
      }
    }
    return { video: b.video, comments: [...b.comments.values()], complete: chainComplete(b),
      capturing: capture?.id === id, stopReason: b.stopReason, progress: b.progress, sourceChanged: currentId() !== id };
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function collect(id, limit, maxSeconds) {
    if (capture) throw new Error("已有采集任务运行中。");
    if (id !== currentId()) throw new Error("原视频页面已切换，请重新绑定当前视频。");
    const b = bucket(id);
    b.stopReason = "";
    const task = { id, stopped: false, lastPageAt: Date.now() };
    capture = task;
    let scroller = null, oldScroll = null;
    try {
      let root = rootPanel();
      if (!root) {
        const button = [...document.querySelectorAll('[data-e2e="feed-comment-icon"],[data-e2e="video-comment-icon"],[data-e2e="comment-icon"]')].find(visible);
        button?.click();
        await delay(1500);
        root = rootPanel();
      }
      if (!root) { b.stopReason = "no_panel"; b.progress = "请回到原视频页，手动展开评论区后重试。"; return; }
      if (chainComplete(b)) { b.progress = `已遍历本次页面返回的 ${b.comments.size} 条一级评论。`; return; }
      scroller = scrollPanel(root);
      if (!scroller) { b.stopReason = "no_scroller"; b.progress = "评论区尚未形成可滚动列表，请展开评论并手动向下滚动一次后重试。"; return; }
      oldScroll = scroller.scrollTop;
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      const started = Date.now();
      let stalled = 0, previousSize = b.comments.size, lastGrowth = Date.now();
      while (true) {
        if (currentId() !== id) { b.stopReason = "changed"; break; }
        readDom(b, root);
        b.progress = `已采集 ${b.comments.size} 条一级评论，正在加载后续评论…`;
        if (chainComplete(b)) { b.progress = `页面遍历结束，已采集 ${b.comments.size} 条一级评论。`; break; }
        if (task.stopped) { b.stopReason = "stopped"; break; }
        if (b.comments.size >= limit) { b.stopReason = "limit"; break; }
        if (Date.now() - started >= maxSeconds * 1000) { b.stopReason = "timeout"; break; }
        if (!visible(root)) {
          root = rootPanel();
          scroller = scrollPanel(root);
          if (!scroller) { b.stopReason = "no_panel"; break; }
        }
        scroller.scrollTop = Math.min(scroller.scrollTop + Math.max(350, scroller.clientHeight * 0.85), scroller.scrollHeight);
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await delay(1200);
        if (b.comments.size === previousSize && Date.now() - task.lastPageAt > 3000) stalled++;
        else { stalled = 0; lastGrowth = Date.now(); }
        previousSize = b.comments.size;
        if (stalled && stalled % 4 === 0) {
          const nextRoot = rootPanel(), nextScroller = scrollPanel(nextRoot);
          if (nextScroller) { root = nextRoot; scroller = nextScroller; }
          // Re-enter the loading edge when an intersection sentinel has stalled.
          scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 150);
          await delay(180); scroller.scrollTop = scroller.scrollHeight;
        }
        if (stalled >= 25 && Date.now() - Math.max(lastGrowth, task.lastPageAt) > 35000) { b.stopReason = "stalled"; break; }
      }
      if (b.stopReason) b.progress = `采集已停止，保留 ${b.comments.size} 条评论；可继续采集。`;
    } catch (err) {
      b.stopReason = "error";
      b.progress = String(err.message || err);
    } finally {
      if (scroller && oldScroll != null && currentId() === id) scroller.scrollTop = oldScroll;
      capture = null;
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    try {
      if (message.type === "SHEET_STATE") {
        watchedId=message.videoId || currentId();
        resync();
        setTimeout(() => { try { respond({ ok: true, state: snapshot(message.videoId) }); } catch (err) { respond({ ok: false, error: err.message }); } }, 120);
        return true;
      }
      else if (message.type === "SHEET_COLLECT") {
        const id = message.videoId || currentId();
        if (capture) throw new Error("已有采集任务运行中。");
        if (id !== currentId()) throw new Error("原视频页面已切换，请重新绑定。");
        collect(id, Math.min(10000, Math.max(20, Number(message.limit) || 5000)), Math.min(600, Math.max(15, Number(message.seconds) || 300)));
        respond({ ok: true });
      } else if (message.type === "SHEET_STOP") { if (capture) capture.stopped = true; respond({ ok: true }); }
    } catch (err) { respond({ ok: false, error: err.message }); }
  });
  function resync() { window.postMessage({ channel: CHANNEL, kind: "resync" }, location.origin); }
  document.addEventListener("DOMContentLoaded", resync, { once: true });
  setTimeout(resync, 800);
  const mountPanel = () => globalThis.mountVideoSheetPanel?.({currentId, snapshot, collect, resync,
    stop: () => { if (capture) capture.stopped = true; }});
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountPanel, {once:true});
  else mountPanel();
})();
