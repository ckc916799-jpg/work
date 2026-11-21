import {coverageText, mergeVideoState, topComments, topCommentsText} from "./core.mjs";
import {parseDouyinLink} from "./video-links.mjs";

const $ = id => document.getElementById(id);
const service = "http://127.0.0.1:18766";
let sourceTab = Number(new URL(location.href).searchParams.get("tab")) || null;
let boundId = "";
let state = {video: {}, comments: [], complete: false};
let token = "";
let workbookFile = null;
let workbookSaveName = "抖音视频素材.xlsx";
let workbookBaseName = "抖音视频素材.xlsx";
let workbookReady = false;
let excelBusy = false;
let linkLoading = false;
let refreshTask = null;
let failedCoverUrl = "";
let batchRows = [];
let batchRunning = false;
let batchStopRequested = false;
let batchUnsaved = 0;
let batchTabId = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function resultName(name) {
  const stamp = new Date().toLocaleString("sv-SE", {timeZone: "Asia/Shanghai", hour12: false}).replace(/\D/g, "").slice(0, 14) + String(Date.now() % 1000).padStart(3, "0");
  return `${String(name || "抖音视频素材.xlsx").replace(/\.xlsx$/i, "")}_采集结果_${stamp}.xlsx`;
}

function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
}

function excelStatus(message, error = false) {
  $("excel-status").textContent = message;
  $("excel-status").classList.toggle("error", error);
}

function safeCover(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
      /(^|\.)(douyinpic\.com|byteimg\.com|bytecdn\.cn|douyin\.com|pstatp\.com)$/.test(url.hostname) ? url.href : "";
  } catch { return ""; }
}

function render() {
  const video = state.video || {};
  $("video-title").textContent = video.title || (video.id ? "视频标题暂未获取，请刷新原视频页" : "请先打开一条抖音视频");
  $("author").textContent = video.author ? `@${video.author}` : "作者待获取";
  $("source-link").href = video.id ? `https://www.douyin.com/video/${video.id}` : "https://www.douyin.com/";
  const cover = safeCover(video.coverUrl);
  if (cover && cover !== failedCoverUrl) {
    if ($("cover-image").src !== cover) $("cover-image").src = cover;
    $("cover-image").hidden = false;
  } else {
    $("cover-image").hidden = true;
    $("cover-image").removeAttribute("src");
  }
  for (const [id, key] of [["likes", "likes"], ["comment-count", "commentCount"], ["collect-count", "collectCount"], ["share-count", "shareCount"]]) {
    $(id).textContent = video[key] == null ? "—" : `${video.metricsApproximate?.[key] ? "约 " : ""}${Number(video[key]).toLocaleString("zh-CN")}`;
  }
  const current = Math.max(0, state.comments.length - (state.retainedComments || 0));
  $("collected").textContent = `已读取 ${current.toLocaleString("zh-CN")} 条一级评论`;
  $("coverage").textContent = coverageText(state);
  $("collect").disabled = !video.id || state.capturing || linkLoading || batchRunning;
  $("open-video").disabled = linkLoading || batchRunning;
  $("stop-comments").disabled = !state.capturing;
  const top = topComments(state.comments);
  $("comments").replaceChildren();
  for (const [index, comment] of top.entries()) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = `${index + 1}. ${comment.author || "匿名用户"}`;
    const likes = document.createElement("span");
    likes.textContent = `${comment.approximate ? "约 " : ""}${comment.likes.toLocaleString("zh-CN")} 赞${comment.retained ? " · 历史保留" : ""}`;
    const body = document.createElement("p");
    body.textContent = comment.text;
    item.append(title, likes, body);
    $("comments").append(item);
  }
  if (!top.length) {
    const empty = document.createElement("li");
    empty.textContent = "展开原视频评论区后，点击“开始／继续采集”。";
    $("comments").append(empty);
  }
  $("excel-preview").value = [
    `视频标题：${video.title || "未获取"}`, `作者：${video.author || "未获取"}`,
    `视频链接：${video.id ? `https://www.douyin.com/video/${video.id}` : "未获取"}`,
    `封面：${video.coverUrl || "未获取"}`,
    ...[["点赞数", "likes"], ["评论数", "commentCount"], ["收藏数", "collectCount"], ["分享数", "shareCount"]].map(([label, key]) =>
      `${label}：${video[key] == null ? "未获取" : `${video.metricsApproximate?.[key] ? "约 " : ""}${video[key]}`}`),
    "内容领域：保存后在 Excel 下拉选择", "", "点赞前二十条一级评论：", topCommentsText(state.comments) || "尚未读取评论。"
  ].join("\n");
  $("write-excel").disabled = !workbookFile || !workbookReady || !video.id || !top.length || state.capturing || excelBusy || batchRunning;
  $("scan-batch").disabled = !workbookReady || batchRunning || excelBusy;
  $("start-batch").disabled = !workbookReady || !batchRows.some(row => row.status !== "完成") || batchRunning || excelBusy;
  $("stop-batch").disabled = !batchRunning;
  $("save-batch").hidden = batchUnsaved === 0;
  $("save-batch").disabled = batchRunning || excelBusy;
  $("choose-excel").disabled = batchRunning || excelBusy;
  $("new-excel").disabled = batchRunning || excelBusy;
  $("excel-sheet").disabled = !workbookReady || batchRunning;
}

async function tabMessage(type, extra = {}, useBound = true) {
  if (!sourceTab) throw new Error("请先在抖音视频页点击插件图标，或在上方粘贴视频链接。");
  try {
    const reply = await chrome.tabs.sendMessage(sourceTab, {type, ...(useBound && boundId ? {videoId: boundId} : {}), ...extra});
    if (!reply?.ok) throw new Error(reply?.error || "抖音页面没有响应。");
    return reply;
  } catch (error) {
    if (/Receiving end|Could not establish|No tab with id/.test(error.message)) throw new Error("无法连接抖音页面。安装本插件后，请刷新视频页再试。");
    throw error;
  }
}

async function bind() {
  const next = (await tabMessage("SHEET_STATE", {}, false)).state;
  if (!next?.video?.id) throw new Error("视频页尚未就绪，请刷新页面或播放视频后重试。");
  if (boundId && boundId !== next.video.id) state = {video: {}, comments: [], complete: false};
  boundId = next.video.id;
  state = mergeVideoState(state, next);
  render();
  notice("视频已读取。请在原视频页展开评论区，再开始采集。");
}

async function refresh() {
  if (!sourceTab || !boundId || linkLoading) return;
  if (refreshTask) return refreshTask;
  refreshTask = (async () => {
    const next = (await tabMessage("SHEET_STATE")).state;
    if (next?.video?.id !== boundId) {
      notice("原视频页已切换到其他视频。请重新读取目标链接。", true);
      return;
    }
    state = mergeVideoState(state, next);
    render();
    if (state.capturing) notice(state.progress || "正在加载评论…");
  })();
  try { await refreshTask; } finally { refreshTask = null; }
}

async function openVideoLink(batch = false) {
  const parsed = parseDouyinLink($("video-link").value);
  if (state.capturing) throw new Error("请先停止当前视频的采集，再读取新链接。");
  linkLoading = true;
  try {
    if (refreshTask) await refreshTask;
    const opened = await chrome.runtime.sendMessage({type: "SHEET_OPEN_LINK", value: parsed.url, batch, reuseTabId: batch ? batchTabId : undefined});
    if (!opened?.ok || !opened.tabId) throw new Error(opened?.error || "插件后台未响应，请在扩展管理页重新加载本插件。");
    const deadline = Date.now() + 35000;
    let candidate = null;
    while (Date.now() < deadline) {
      try {
        const response = await Promise.race([
          chrome.tabs.sendMessage(opened.tabId, {type: "SHEET_STATE"}),
          new Promise((_, reject) => setTimeout(() => reject(new Error("页面响应超时")), 3000))
        ]);
        const next = response?.state;
        if (response?.ok && /^\d+$/.test(next?.video?.id || "") && (!parsed.id || next.video.id === parsed.id)) {
          candidate = next;
          if (next.video.title || next.video.likes != null) break;
        }
      } catch { /* 短链接可能仍在跳转。 */ }
      await sleep(1000);
    }
    if (!candidate) throw new Error("视频页尚未就绪。请在刚打开的抖音页完成登录或验证，再重试。");
    if (boundId !== candidate.video.id) state = {video: {}, comments: [], complete: false};
    sourceTab = opened.tabId;
    if (batch) batchTabId = opened.tabId;
    boundId = candidate.video.id;
    state = mergeVideoState(state, candidate);
    const address = new URL(location.href);
    address.searchParams.set("tab", String(sourceTab));
    history.replaceState(null, "", address);
    $("link-status").textContent = "视频已读取。请在原视频页展开评论区。";
    render();
    notice("视频已读取。");
  } finally { linkLoading = false; render(); }
}

async function serviceRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${service}${path}`, {
      ...options,
      headers: {...options.headers, ...(token ? {"X-Sheet-Token": token} : {})},
      signal: options.signal || AbortSignal.timeout(30000)
    });
  } catch { throw new Error("未连接本插件的本地服务。请运行 local-service/Start-Service.bat。"); }
  let result;
  try { result = await response.json(); } catch { throw new Error("本地服务返回异常，请重新启动本插件的服务。"); }
  if (!response.ok) throw new Error(result.error || `本地服务返回 ${response.status}`);
  return result;
}

async function checkService() {
  const health = await serviceRequest("/health", {signal: AbortSignal.timeout(5000)});
  if (health.app !== "douyin-video-sheet" || health.version !== "1.2.0") throw new Error("本插件需要新版本地服务。请先运行旧版的 Stop-Service.bat，再运行新版的 Start-Service.bat。");
  if (!health.excel_ready) throw new Error("请先运行本插件的 local-service/Setup-Excel.bat。");
  if (!token) throw new Error("请在“本地服务连接设置”中粘贴本插件的 connection-token.txt 连接码。");
  await serviceRequest("/session/check");
  $("service-status").textContent = "本插件的本地服务已连接，可以选择 Excel 文件。";
}

function fileBase64(file) {
  if (!file.size) return Promise.resolve("");
  if (file.size > 25 * 1024 * 1024) throw new Error("Excel 文件超过 25MB，请选择较小的表格。");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(reader.error || new Error("读取 Excel 文件失败。"));
    reader.readAsDataURL(file);
  });
}

function base64Bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function selectWorkbook(file, saveName) {
  if (!file || !/\.xlsx$/i.test(file.name || "")) throw new Error("请选择 .xlsx 格式的 Excel 文件。");
  workbookFile = file;
  workbookBaseName = saveName;
  workbookSaveName = resultName(saveName);
  workbookReady = false;
  batchRows = [];
  batchUnsaved = 0;
  $("batch-list").replaceChildren();
  $("batch-status").textContent = "尚未读取待采集链接。";
  $("excel-file").textContent = `已选择：${file.name}`;
  $("excel-sheet").replaceChildren(new Option("正在读取工作表…", ""));
  $("excel-sheet").disabled = true;
  $("retry-excel").hidden = false;
  excelStatus(`已选择 ${file.name}，正在检查文件和本地服务…`);
  render();
  await inspectSelectedWorkbook();
}

async function inspectSelectedWorkbook() {
  if (!workbookFile) throw new Error("请先选择 Excel 文件。");
  workbookReady = false;
  render();
  excelStatus(`正在读取 ${workbookFile.name} 的工作表…`);
  await checkService();
  const inspection = await serviceRequest("/workbooks/inspect", {method: "POST", body: JSON.stringify({workbook: await fileBase64(workbookFile)}),
    headers: {"Content-Type": "application/json"}, signal: AbortSignal.timeout(30000)});
  if (!Array.isArray(inspection.sheets) || !inspection.sheets.length) throw new Error("本地服务没有返回工作表，请重新选择文件。");
  $("excel-sheet").replaceChildren();
  for (const name of inspection.sheets) $("excel-sheet").add(new Option(name, name));
  if (workbookFile.size) $("excel-sheet").add(new Option("在此文件中新建“视频数据采集”工作表", "__new__"));
  $("excel-sheet").disabled = false;
  workbookReady = true;
  $("retry-excel").hidden = true;
  excelStatus(`已读取 ${workbookFile.name}：请选择工作表，核对预览后写入。`);
  render();
}

async function saveWorkbook(bytes, suggestedName) {
  if (!chrome.downloads?.download || !chrome.downloads?.onChanged) throw new Error("浏览器下载功能不可用，请在扩展管理页重新加载本插件。");
  const url = URL.createObjectURL(new Blob([bytes], {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
  try {
    const id = await chrome.downloads.download({url, filename: suggestedName, saveAs: true, conflictAction: "uniquify"});
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        error ? reject(error) : resolve();
      };
      const listener = change => {
        if (change.id !== id) return;
        if (change.state?.current === "complete") finish();
        else if (change.state?.current === "interrupted") finish(new Error(`Excel 保存中断（${change.error?.current || "原因未知"}）。请另选新文件名；若原文件正由 WPS／Excel 打开，先关闭它。`));
      };
      const timer = setTimeout(() => finish(new Error("等待保存超时，请检查浏览器下载列表。")), 10 * 60 * 1000);
      chrome.downloads.onChanged.addListener(listener);
      chrome.downloads.search({id}).then(items => {
        if (items[0]?.state === "complete") finish();
        else if (items[0]?.state === "interrupted") finish(new Error(`Excel 保存中断（${items[0]?.error || "原因未知"}）。请另选新文件名；若原文件正由 WPS／Excel 打开，先关闭它。`));
      }).catch(error => finish(error));
    });
  } finally { URL.revokeObjectURL(url); }
}

function recordFromState(extra = {}) {
  const video = state.video;
  return {
    videoId: video.id, title: video.title || "", author: video.author || "", coverUrl: video.coverUrl || "",
    likes: video.likes ?? null, commentCount: video.commentCount ?? null, collectCount: video.collectCount ?? null,
    shareCount: video.shareCount ?? null, metricsApproximate: video.metricsApproximate || {},
    topComments: topCommentsText(state.comments), ...extra
  };
}

function showBatchRows() {
  $("batch-list").replaceChildren();
  for (const row of batchRows) {
    const item = document.createElement("li");
    item.textContent = `第 ${row.row} 行：${row.status || "待采集"} · ${row.url}`;
    $("batch-list").append(item);
  }
  render();
}

async function scanBatch() {
  if (!workbookReady || !workbookFile) throw new Error("请先选择已经填好视频链接的 Excel 文件。");
  if ($("excel-sheet").value === "__new__") throw new Error("请先选择填有视频链接的工作表。");
  await checkService();
  const result = await serviceRequest("/workbooks/pending", {method: "POST", body: JSON.stringify({workbook: await fileBase64(workbookFile), sheet: $("excel-sheet").value}),
    headers: {"Content-Type": "application/json"}, signal: AbortSignal.timeout(30000)});
  batchRows = (result.rows || []).map(row => ({...row, status: "待采集"}));
  $("batch-status").textContent = batchRows.length
    ? `找到 ${result.total} 条待采集链接；本次将处理前 ${batchRows.length} 条。`
    : "这张工作表没有待采集链接。请在 D 列填链接，保存后重新选择文件。";
  showBatchRows();
}

async function saveBatchResults() {
  if (!batchUnsaved || !workbookFile) throw new Error("没有待保存的批量结果。");
  if (excelBusy) throw new Error("正在保存，请稍候。");
  excelBusy = true;
  render();
  try {
    $("batch-status").textContent = `已完成 ${batchUnsaved} 条，正在打开“另存为”窗口…`;
    const savedName = workbookSaveName;
    await saveWorkbook(new Uint8Array(await workbookFile.arrayBuffer()), savedName);
    batchUnsaved = 0;
    $("excel-file").textContent = `当前表格：${savedName}（已包含批量采集结果）`;
    const completed = batchRows.filter(row => row.status?.startsWith("完成")).length;
    const failed = batchRows.filter(row => row.status?.startsWith("失败")).length;
    $("batch-status").textContent = `批量结果已保存为 ${savedName}；完成 ${completed} 条，失败 ${failed} 条。下次继续采集时，请选择这份更新后的文件。`;
    workbookSaveName = resultName(workbookBaseName);
  } finally { excelBusy = false; render(); }
}

async function runBatch() {
  if (batchRunning) return;
  if (!batchRows.some(row => row.status !== "完成")) throw new Error("请先读取待采集链接。");
  await checkService();
  batchRunning = true;
  batchStopRequested = false;
  render();
  let success = 0, failed = 0;
  try {
    for (const row of batchRows) {
      if (batchStopRequested) break;
      if (row.status === "完成") continue;
      row.status = "正在读取视频";
      showBatchRows();
      $("batch-status").textContent = `正在处理第 ${row.row} 行；已完成 ${success} 条，失败 ${failed} 条。`;
      try {
        parseDouyinLink(row.url);
        $("video-link").value = row.url;
        await openVideoLink(true);
        if (batchStopRequested) break;
        const limit = Number($("batch-limit").value);
        const seconds = Number($("batch-seconds").value);
        await tabMessage("SHEET_COLLECT", {limit, seconds});
        await refresh();
        const deadline = Date.now() + (seconds + 30) * 1000;
        let stopSent = false;
        while (state.capturing && Date.now() < deadline) {
          if (batchStopRequested && !stopSent) { await tabMessage("SHEET_STOP"); stopSent = true; }
          await sleep(1200);
          await refresh();
          row.status = `已读取 ${Math.max(0, state.comments.length - (state.retainedComments || 0))} 条评论`;
          showBatchRows();
        }
        if (state.capturing) { await tabMessage("SHEET_STOP"); await sleep(1200); await refresh(); }
        if (!topComments(state.comments).length) throw new Error("未获取可排序的评论；请检查视频页是否需要登录或展开评论区。");
        row.status = "正在写入表格";
        showBatchRows();
        const result = await serviceRequest("/workbooks/write", {method: "POST", body: JSON.stringify({workbook: await fileBase64(workbookFile), sheet: $("excel-sheet").value,
          record: recordFromState({targetRow: row.row, sourceLink: row.url})}), headers: {"Content-Type": "application/json"}, signal: AbortSignal.timeout(90000)});
        const bytes = base64Bytes(result.workbook);
        workbookFile = new File([bytes], workbookSaveName, {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
        batchUnsaved++;
        success++;
        row.status = `完成（${state.comments.length} 条评论中取前 20）`;
        showBatchRows();
      } catch (error) {
        failed++;
        row.status = `失败：${error.message || "未知原因"}`;
        showBatchRows();
      }
    }
  } finally {
    batchRunning = false;
    $("batch-status").textContent = `本轮结束：完成 ${success} 条，失败 ${failed} 条${batchStopRequested ? "，已停止" : ""}。${batchUnsaved ? "正在保存结果…" : ""}`;
    render();
  }
  if (batchUnsaved) await saveBatchResults();
}

async function writeExcel() {
  if (!workbookFile) throw new Error("请先选择 Excel 文件。");
  if (!workbookReady) throw new Error("工作表尚未读取成功，请点击“重新读取工作表”。");
  if (!state.video?.id || !topComments(state.comments).length) throw new Error("请先读取视频并采集评论。");
  if (state.capturing) throw new Error("请先停止评论采集，再写入表格。");
  await checkService();
  const record = recordFromState();
  const result = await serviceRequest("/workbooks/write", {method: "POST", body: JSON.stringify({workbook: await fileBase64(workbookFile), sheet: $("excel-sheet").value, record}),
    headers: {"Content-Type": "application/json"}, signal: AbortSignal.timeout(90000)});
  const updated = base64Bytes(result.workbook);
  excelStatus("表格内容已生成。请在浏览器弹出的“另存为”窗口确认保存位置…");
  const savedName = workbookSaveName;
  await saveWorkbook(updated, savedName);
  workbookFile = new File([updated], savedName, {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
  $("excel-file").textContent = `当前表格：${savedName}（已包含刚写入的数据）`;
  workbookSaveName = resultName(workbookBaseName);
  batchUnsaved = 0;
  if (![...$("excel-sheet").options].some(option => option.value === result.sheet)) $("excel-sheet").add(new Option(result.sheet, result.sheet));
  $("excel-sheet").value = result.sheet;
  excelStatus(`已保存更新后的 Excel：${result.sheet} 第 ${result.row} 行（${result.action}）。${result.warnings?.join(" ") || ""}`);
  notice($("excel-status").textContent);
}

$("cover-image").addEventListener("error", () => { failedCoverUrl = $("cover-image").src; $("cover-image").hidden = true; });
$("open-video").addEventListener("click", async () => {
  if (linkLoading) return;
  try { await openVideoLink(); } catch (error) { $("link-status").textContent = error.message; notice(error.message, true); }
});
$("collect").addEventListener("click", async () => {
  try {
    if (!boundId) await bind();
    await tabMessage("SHEET_COLLECT", {limit: Number($("limit").value), seconds: Number($("seconds").value)});
    await refresh();
    notice("正在采集评论，界面会持续更新已读取数量。");
  } catch (error) { notice(error.message, true); }
});
$("stop-comments").addEventListener("click", async () => {
  try { await tabMessage("SHEET_STOP"); } catch (error) { notice(error.message, true); }
});
$("connect").addEventListener("click", async () => {
  token = $("token").value.trim();
  try {
    await checkService();
    await chrome.storage.local.set({token});
    notice("本插件的本地服务已连接。");
  } catch (error) {
    $("service-status").textContent = error.message;
    if (workbookFile && !workbookReady) { excelStatus(`读取失败：${error.message}`, true); $("retry-excel").hidden = false; }
    notice(error.message, true);
    return;
  }
  if (workbookFile && !workbookReady) {
    try { await inspectSelectedWorkbook(); }
    catch (error) { excelStatus(`读取失败：${error.message}`, true); $("retry-excel").hidden = false; notice(error.message, true); }
  }
});
$("choose-excel").addEventListener("click", () => {
  $("excel-input").click();
});
$("excel-input").addEventListener("change", async () => {
  const file = $("excel-input").files?.[0];
  if (!file) return;
  $("excel-input").value = "";
  if (batchUnsaved && !confirm("当前还有未保存的批量结果。换文件会丢失这些结果，确定继续吗？")) return;
  try { await selectWorkbook(file, file.name); }
  catch (error) {
    const message = error.message || `${error.name || "未知错误"}，请重试。`;
    excelStatus(`读取失败：${message}`, true);
    $("retry-excel").hidden = !workbookFile;
    notice(message, true);
  }
});
$("new-excel").addEventListener("click", async () => {
  if (batchUnsaved && !confirm("当前还有未保存的批量结果。新建文件会丢失这些结果，确定继续吗？")) return;
  try {
    const name = "抖音视频素材.xlsx";
    await selectWorkbook(new File([], name, {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}), name);
  } catch (error) {
    const message = error.message || `${error.name || "未知错误"}，请重试。`;
    excelStatus(`读取失败：${message}`, true);
    $("retry-excel").hidden = !workbookFile;
    notice(message, true);
  }
});
$("retry-excel").addEventListener("click", async () => {
  try { await inspectSelectedWorkbook(); }
  catch (error) {
    const message = error.message || `${error.name || "未知错误"}，请重试。`;
    excelStatus(`读取失败：${message}`, true);
    notice(message, true);
  }
});
$("excel-sheet").addEventListener("change", () => {
  batchRows = [];
  $("batch-list").replaceChildren();
  $("batch-status").textContent = "工作表已切换，请重新读取待采集链接。";
  render();
});
$("write-excel").addEventListener("click", async () => {
  if (excelBusy) return;
  excelBusy = true;
  excelStatus("正在生成更新后的 Excel…");
  render();
  try { await writeExcel(); }
  catch (error) { excelStatus(error.message || "写入失败，请重试。", true); notice($("excel-status").textContent, true); }
  finally { excelBusy = false; render(); }
});
$("template").addEventListener("click", async () => {
  try {
    const response = await fetch(chrome.runtime.getURL("batch-template.xlsx"));
    if (!response.ok) throw new Error("批量模板未找到，请重新安装本插件。");
    await saveWorkbook(new Uint8Array(await response.arrayBuffer()), "抖音批量链接模板.xlsx");
    $("batch-status").textContent = "模板已保存。请在 D 列填写视频链接，保存后选择这份 Excel。";
  } catch (error) { $("batch-status").textContent = `模板保存失败：${error.message}`; notice(error.message, true); }
});
$("scan-batch").addEventListener("click", async () => {
  try { await scanBatch(); }
  catch (error) { $("batch-status").textContent = `读取待采集链接失败：${error.message}`; notice(error.message, true); }
});
$("start-batch").addEventListener("click", async () => {
  try { await runBatch(); }
  catch (error) { $("batch-status").textContent = `批量采集停止：${error.message}`; notice(error.message, true); }
});
$("stop-batch").addEventListener("click", async () => {
  batchStopRequested = true;
  $("batch-status").textContent = "正在停止当前视频采集；已完成的记录会保留并保存。";
  if (state.capturing) await tabMessage("SHEET_STOP").catch(() => {});
});
$("save-batch").addEventListener("click", async () => {
  try { await saveBatchResults(); }
  catch (error) { $("batch-status").textContent = `保存失败：${error.message}。已采集数据仍留在当前页面，可重试保存。`; notice(error.message, true); }
});
for (const name of ["limit", "seconds"]) $(name).addEventListener("change", () => chrome.storage.local.set({[name]: $(name).value}));

const saved = await chrome.storage.local.get(["token", "limit", "seconds"]);
token = saved.token || "";
$("token").value = token;
for (const name of ["limit", "seconds"]) if (saved[name]) $(name).value = saved[name];
try { if (sourceTab) await bind(); } catch (error) { notice(error.message, true); }
render();
setInterval(() => refresh().catch(error => notice(error.message, true)), 1500);
