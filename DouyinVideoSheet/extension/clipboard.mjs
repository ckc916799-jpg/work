import {mergeCommentRows, topComments, topCommentsText} from "./core.mjs";

// One physical line per record: tabs/newlines cannot split a pasted cell.
// Treat source captions and user comments as text, never spreadsheet formulas.
export function textCell(value) {
  const text = String(value ?? "").replace(/[\t\r\n\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
  return /^[=+@-]/.test(text) ? "'" + text : text;
}
export const VIDEO_HEADERS = ["视频ID", "封面链接", "视频链接", "作者", "标题", "点赞数", "评论数", "收藏数", "分享数", "数据说明"];
function videoId(state) {
  const id = String(state?.video?.id ?? "");
  if (!/^\d{1,24}$/.test(id)) throw new Error("未识别到有效视频ID，请打开视频详情页。");
  return id;
}
export function videoFields(state) {
  const id = videoId(state), v = state.video;
  const keys = ["likes", "commentCount", "collectCount", "shareCount"];
  const notes = keys.filter(key => v.metricsApproximate?.[key]).map(key => ({likes:"点赞",commentCount:"评论",collectCount:"收藏",shareCount:"分享"}[key]) + "为页面约数");
  const url = v.url === `https://www.douyin.com/note/${id}` ? v.url : `https://www.douyin.com/video/${id}`;
  const values = [id, v.coverUrl, url, v.author, v.title, ...keys.map(key => v[key]), notes.join("；")];
  return VIDEO_HEADERS.map((label, index) => ({label, value: values[index] ?? ""}));
}
export function videoTSV(state) {
  return videoFields(state).map(field => textCell(field.value)).join("\t");
}
export function commentsText(state) {
  const id = videoId(state);
  const rows = topComments(mergeCommentRows([], state.comments, id), 20);
  const clean = value => String(value ?? "").replace(/[\t\r\n\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
  const text = topCommentsText(rows.map(c => ({...c, text:clean(c.text), author:clean(c.author)})));
  const escaped = text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")
    .replace(/\n/g,'<br style="mso-data-placement:same-cell">');
  return {count: rows.length, text, html:`<html><head><meta charset="utf-8"></head><body><table><tbody><tr><td style="white-space:pre-wrap">${escaped}</td></tr></tbody></table></body></html>`};
}
