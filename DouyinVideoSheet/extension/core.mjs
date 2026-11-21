export function parseCount(value) {
  if (value == null || String(value).trim() === "") return null;
  const match = String(value).replace(/[,，\s]/g, "").match(/^(\d+(?:\.\d+)?)([万亿wWkKmM]?)\+?$/);
  if (!match) return null;
  const number = Math.round(Number(match[1]) * ({万: 1e4, 亿: 1e8, w: 1e4, W: 1e4, k: 1e3, K: 1e3, m: 1e6, M: 1e6}[match[2]] || 1));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function mergeCommentRows(previous = [], incoming = [], videoId = "") {
  const rows = new Map();
  const priority = item => ({api: 3, page: 2, dom: 1}[item.source] || 0);
  for (const item of [...previous, ...incoming]) {
    if (!item?.id || typeof item.text !== "string" || !item.text.trim() || item.isReply || (videoId && item.videoId && String(item.videoId) !== String(videoId))) continue;
    const likes = parseCount(item.likes);
    if (likes == null) continue;
    const id = String(item.id), prior = rows.get(id);
    if (!prior || priority(item) > priority(prior) || (priority(item) === priority(prior) && (item.observedAt || 0) >= (prior.observedAt || 0))) rows.set(id, {...item, id, likes});
  }
  return [...rows.values()];
}

export function mergeVideoState(previous, next) {
  if (!previous?.video?.id || previous.video.id !== next?.video?.id) return next;
  const video = {...previous.video};
  for (const [key, value] of Object.entries(next.video)) {
    if (value == null || value === "") continue;
    if (key === "metricsApproximate") video.metricsApproximate = {...previous.video.metricsApproximate, ...value};
    else video[key] = value;
  }
  const live = mergeCommentRows([], next.comments, video.id);
  const complete = Boolean(next.complete && (live.length || !previous.comments?.length || next.video.commentCount === 0));
  const merged = complete ? live : mergeCommentRows(previous.comments, live, video.id);
  const liveIds = new Set(live.map(row => row.id));
  const comments = merged.map(row => ({...row, retained: !liveIds.has(row.id)}));
  return {...next, video, comments, retainedComments: comments.length - live.length, complete};
}

export function topComments(comments, count = 20) {
  return mergeCommentRows([], comments).sort((a, b) => b.likes - a.likes || String(a.id).localeCompare(String(b.id))).slice(0, count);
}

export function topCommentsText(comments) {
  return topComments(comments).map((item, index) =>
    `${index + 1}. ${item.approximate ? "约 " : ""}${item.likes.toLocaleString("zh-CN")} 赞 | ${item.author || "匿名用户"}${item.retained ? "（历史保留）" : ""}\n${item.text.trim()}`
  ).join("\n\n");
}

export function coverageText(state) {
  const current = Math.max(0, (state.comments?.length || 0) - (state.retainedComments || 0));
  const retained = state.retainedComments ? `；另保留历史 ${state.retainedComments} 条` : "";
  if (state.complete) return `本次页面返回的 ${current} 条一级评论已遍历${retained}。`;
  const reason = {limit: "达到采集上限", timeout: "达到时间上限", stopped: "手动停止", stalled: "页面未继续加载", changed: "视频已切换", error: "采集中断", no_panel: "未找到评论区", no_scroller: "评论区不能滚动"}[state.stopReason];
  return `已读取 ${current} 条一级评论${retained}；${reason || "仍可继续采集"}。前二十名只按已读取评论排序。`;
}
