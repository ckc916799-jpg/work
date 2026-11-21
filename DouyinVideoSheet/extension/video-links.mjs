export function parseDouyinLink(value) {
  const text = String(value || "").trim();
  if (text.length > 10000) throw new Error("分享文字过长，请只粘贴视频链接。");
  const match = text.match(/(?:https?:\/\/)?(?:v\.douyin\.com|www\.douyin\.com|douyin\.com)\/[^\s<>"‘’“”]+/i);
  if (!match) throw new Error("请粘贴抖音视频链接，或包含链接的整段分享文字。");
  const raw = match[0].replace(/[。，,;；!！?？)）\]】]+$/u, "");
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port!=="443")) throw new Error("请使用抖音 HTTPS 视频链接。");
  if (url.hostname === "v.douyin.com" && /^\/[\w-]{4,80}\/?$/.test(url.pathname)) return {url:`https://v.douyin.com${url.pathname}`,id:""};
  if (["www.douyin.com","douyin.com"].includes(url.hostname)) {
    const id = url.pathname.match(/^\/video\/(\d{1,24})\/?$/)?.[1] || url.searchParams.get("modal_id") || url.searchParams.get("aweme_id");
    if (/^\d{1,24}$/.test(id || "")) return {url:`https://www.douyin.com/video/${id}`,id};
  }
  throw new Error("这个链接没有指向单条视频，请复制视频的分享链接。");
}
