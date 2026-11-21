(() => {
  // Only shared with bridge.js in the extension's isolated world.
  globalThis.mountVideoSheetPanel = async api => {
    let format;
    try { format = await import(chrome.runtime.getURL("clipboard.mjs")); }
    catch (error) { console.error("Video Sheet panel could not load", error); return; }
    const host = document.createElement("div");
    host.id = "douyin-video-sheet-panel";
    host.style.cssText = 'all:initial!important;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif!important;color:#183c32!important;color-scheme:light!important;position:fixed!important;right:16px!important;bottom:80px!important;z-index:2147483647!important;display:block!important';
    const root = host.attachShadow({mode:"closed"});
    root.innerHTML = `
      <style>
        :host{font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#183c32;color-scheme:light}
        *{box-sizing:border-box} [hidden]{display:none!important}
        button,input,textarea{font:inherit}button{cursor:pointer;border:0;border-radius:9px;padding:10px 12px;background:#14775e;color:#fff}
        button:hover{filter:brightness(.92)}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #ddaa28;outline-offset:2px}
        #toggle{box-shadow:0 3px 20px #0003}section{width:min(330px,calc(100vw - 32px));max-height:calc(100vh - 160px);overflow:auto;border:1px solid #b9d5c8;border-radius:14px;padding:16px;background:#fff;box-shadow:0 8px 32px #0003;margin-bottom:8px}
        header{display:flex;justify-content:space-between;align-items:center;gap:12px}header button{padding:4px 9px;background:#e7f1ec;color:#183c32}h2{font-size:16px;margin:0}
        p{margin:10px 0;overflow-wrap:anywhere}#title{font-weight:600;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
        .hint{font-size:12px;color:#536e63}#actions{display:grid;gap:8px}label{display:flex;align-items:center;gap:6px;margin:10px 0;font-size:12px}
        #status{font-size:12px;white-space:pre-wrap;min-height:18px}textarea{width:100%;height:100px;border:1px solid #aacbbc;border-radius:6px;padding:6px;color:#183c32;background:#fff}
        details{margin-top:12px;font-size:12px}summary{cursor:pointer;color:#14775e}dl{display:grid;grid-template-columns:90px minmax(0,1fr);gap:6px;margin:8px 0;max-height:190px;overflow:auto}dt{color:#536e63}dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap;max-height:60px;overflow:auto}
      </style>
      <section id="panel" aria-label="抖音视频入表" hidden>
        <header><h2>抖音视频入表</h2><button id="close" aria-label="收起面板">收起</button></header>
        <p id="title">等待视频信息…</p><p id="identity" class="hint"></p><p id="metrics" class="hint"></p>
        <div id="actions"><button id="video">复制视频信息</button><button id="comments">采集并复制高赞评论 TOP20</button><button id="stop" hidden>停止采集并复制已有评论</button></div>
        <details open><summary>视频字段（按粘贴列顺序）</summary><dl id="fields"></dl></details>
        <p class="hint">视频仅复制一行数据，不带字段名。ID 列先设为文本；封面为链接。评论为一个单元格的排序文本，仅按已读取范围排序。最多读取 5000 条、300 秒。</p>
        <p id="status" role="status" aria-live="polite"></p>
        <div id="manual" hidden><p class="hint">自动复制未成功，请点击下方文本框，按 Ctrl+C。评论请先双击目标单元格进入编辑状态再粘贴，以保留在一个单元格中。</p><textarea id="fallback" readonly aria-label="待复制的数据"></textarea><button id="retry">重新复制</button></div>
      </section>
      <button id="toggle" aria-expanded="false" aria-controls="panel">入表 · 展开</button>`;
    const $ = id => root.getElementById(id);
    let id = "", job = null, copying = false, opened = false, pendingHtml = "", lastRecovery = 0;
    const notice = text => { $("status").textContent = text; };
    function setOpen(value) {
      opened = value; $("panel").hidden = !value;
      $("toggle").textContent = value ? "入表 · 收起" : "入表 · 展开";
      $("toggle").setAttribute("aria-expanded", String(value));
      if (value) { api.resync(); refresh(); }
    }
    $("toggle").onclick = () => setOpen(!opened);
    $("close").onclick = () => { setOpen(false); $("toggle").focus(); };
    root.addEventListener("keydown", event => { if (event.key === "Escape") setOpen(false); });
    function clearCopy() { $("manual").hidden = true; $("fallback").value = ""; pendingHtml = ""; }
    function stillCurrent(expected) { return expected && api.currentId() === expected && id === expected; }
    async function copy(text, expected, message, html = "") {
      if (!stillCurrent(expected)) throw new Error("视频已切换，本次结果未复制，请重新操作。");
      clearCopy();
      try {
        if (html) {
          if (!navigator.clipboard.write || typeof ClipboardItem === "undefined") throw new Error("需要手动复制");
          await navigator.clipboard.write([new ClipboardItem({"text/plain":new Blob([text],{type:"text/plain"}),"text/html":new Blob([html],{type:"text/html"})})]);
        } else await navigator.clipboard.writeText(text);
        if (!stillCurrent(expected)) { notice("复制期间视频已切换，剪贴板为上一条视频，请重新复制当前视频。"); return; }
        notice(message);
      } catch {
        if (!stillCurrent(expected)) throw new Error("视频已切换，本次结果未复制。");
        $("fallback").value = text; pendingHtml = html; $("manual").hidden = false;
        $("fallback").focus(); $("fallback").select();
        notice("自动复制失败，已保留内容供手动复制。");
      }
    }
    $("fallback").onclick = () => $("fallback").select();
    $("retry").onclick = () => {
      const text = $("fallback").value, expected = id;
      if (text) copy(text, expected, "已复制，可粘贴到 WPS。", pendingHtml).catch(error => notice(error.message));
    };
    $("video").onclick = async () => {
      const expected = id;
      copying = true; refresh();
      try {
        api.resync(); await new Promise(resolve => setTimeout(resolve, 150));
        if (!stillCurrent(expected)) throw new Error("视频已切换，请重新复制。");
        const state = api.snapshot(expected);
        await copy(format.videoTSV(state), expected,
          "已复制 1 行视频数据，不带字段名。字段顺序见上方列表；未读取到的字段留空。");
      } catch (error) { notice(error.message); }
      finally { copying = false; refresh(); }
    };
    $("comments").onclick = async () => {
      const expected = id;
      const task = {id: expected};
      job = task; clearCopy(); refresh();
      notice("正在采集评论，可停止并复制已有结果…");
      try {
        api.resync();
        await api.collect(expected, 5000, 300);
        if (!stillCurrent(expected) || job !== task) throw new Error("视频已切换，本次评论未复制，请在当前视频重新采集。");
        const state = api.snapshot(expected);
        const result = format.commentsText(state);
        if (!result.count) { notice(state.progress || "未读取到可用评论。请手动展开评论区后重试。原剪贴板未改动。"); return; }
        const coverage = state.stopReason ? `（${({no_panel:"未找到评论区",no_scroller:"评论区不能滚动",stopped:"手动停止",timeout:"达到时间上限",limit:"达到数量上限",stalled:"页面未继续加载",error:"采集中断"})[state.stopReason] || state.stopReason}）` : "";
        await copy(result.text, expected, `已复制 ${result.count} 条评论为单元格文本${coverage}，按已读取的 ${state.comments.length} 条排序。若 WPS 拆行，请双击单元格后再粘贴。`, result.html);
      } catch (error) { notice(error.message); }
      finally { if (job === task) job = null; refresh(); }
    };
    $("stop").onclick = () => { api.stop(); notice("正在停止，将复制已读取范围内的前20条…"); };
    function refresh() {
      const next = api.currentId();
      const valid = /^\d{1,24}$/.test(next);
      if (id !== next) {
        id = next; clearCopy();
        notice(job ? "视频已切换，正在结束上一条的采集，不会自动复制。" : "");
      }
      // Hide without relying on page CSS, including on SPA routes without a video.
      host.style.setProperty("display", valid ? "block" : "none", "important");
      $("video").disabled = !valid || copying || Boolean(job);
      $("comments").disabled = !valid || copying || Boolean(job);
      $("stop").hidden = !job;
      if (!valid || (!opened && !job)) return;
      try {
        const state = api.snapshot(id), v = state.video;
        if (Date.now() - lastRecovery > 3000 && [v.coverUrl,v.author,v.likes,v.collectCount,v.shareCount].some(value => value == null || value === "")) {
          lastRecovery = Date.now(); api.resync();
        }
        $("title").textContent = v.title || "视频信息尚未完整加载，可刷新视频页重试";
        $("identity").textContent = `${v.author || "作者未知"} · ID ${id}`;
        $("metrics").textContent = [["点赞","likes"],["评论","commentCount"],["收藏","collectCount"],["分享","shareCount"]]
          .map(([label,key]) => `${label} ${v[key] == null ? "—" : (v.metricsApproximate?.[key] ? "约" : "") + v[key]}`).join(" · ");
        const fields = format.videoFields(state).flatMap((field, index) => {
          const label = document.createElement("dt"), value = document.createElement("dd");
          label.textContent = `${index + 1}. ${field.label}`;
          value.textContent = field.value === "" ? "—" : String(field.value);
          return [label, value];
        });
        $("fields").replaceChildren(...fields);
        if (job?.id === id && state.capturing) notice(state.progress || "正在打开评论区并采集…");
      } catch (error) { notice(error.message); }
    }
    document.documentElement.appendChild(host);
    refresh(); setInterval(refresh, 800);
  };
})();
