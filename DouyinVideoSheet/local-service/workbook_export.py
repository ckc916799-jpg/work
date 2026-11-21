"""Create or update one Douyin video row in an XLSX workbook."""
from __future__ import annotations

from io import BytesIO
import re
import warnings
from zipfile import ZipFile
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from openpyxl import Workbook, load_workbook
from openpyxl.drawing.image import Image as WorkbookImage
from openpyxl.drawing.spreadsheet_drawing import AnchorMarker, TwoCellAnchor
from openpyxl.utils.units import pixels_to_EMU
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.styles import Alignment, Font, PatternFill
from PIL import Image as PillowImage


MAX_WORKBOOK_BYTES = 25 * 1024 * 1024
MAX_COVER_BYTES = 6 * 1024 * 1024
OLD_HEADERS = ["封面", "视频标题", "作者", "视频链接", "点赞数", "评论数", "收藏数", "分享数", "高赞评论前20", "视频ID"]
HEADERS = OLD_HEADERS + ["内容领域"]
DEFAULT_SHEET = "视频数据采集"
OPTIONS_SHEET = "内容领域选项"
OPTIONS_NAME = "VideoSheetContentAreas"
OPTIONS_LAST_ROW = 201
COVER_DOMAINS = ("douyinpic.com", "byteimg.com", "bytecdn.cn", "douyin.com", "pstatp.com")


class WorkbookExportError(ValueError):
    pass


def _load(data: bytes, *, read_only: bool = False):
    if len(data) > MAX_WORKBOOK_BYTES:
        raise WorkbookExportError("Excel 文件超过 25MB，请选择较小的素材清单。")
    try:
        with ZipFile(BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 2000 or sum(entry.file_size for entry in entries) > 100 * 1024 * 1024:
                raise WorkbookExportError("Excel 文件解压后过大，请选择较小的素材清单。")
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            workbook = load_workbook(BytesIO(data), read_only=read_only, keep_links=True)
        if caught:
            workbook.close()
            raise WorkbookExportError("此文件包含当前写入器无法保留的 Excel 功能。请新建一个采集表，以免改动原文件。")
        return workbook
    except WorkbookExportError:
        raise
    except Exception as exc:
        raise WorkbookExportError("无法读取此 Excel 文件。请选择有效的 .xlsx 文件。") from exc


def sheet_names(data: bytes) -> list[str]:
    if not data:
        return [DEFAULT_SHEET]
    workbook = _load(data, read_only=True)
    try:
        return [name for name in workbook.sheetnames if name != OPTIONS_SHEET or workbook[name]["A1"].value != "内容领域选项"]
    finally:
        workbook.close()


def pending_links(data: bytes, sheet_name: str, limit: int = 20) -> dict:
    if not data:
        return {"rows": [], "total": 0}
    workbook = _load(data, read_only=True)
    try:
        if sheet_name not in workbook.sheetnames:
            raise WorkbookExportError("所选工作表不存在，请重新选择。")
        sheet = workbook[sheet_name]
        rows = sheet.iter_rows(values_only=True)
        header = next(rows, ())
        if list(header[:10]) != OLD_HEADERS or (len(header) > 10 and header[10] not in (None, HEADERS[10])):
            raise WorkbookExportError("批量采集需要本插件的表格列。请使用“批量链接模板”或新建工作表。")
        pending = []
        total = 0
        for index, cells in enumerate(rows, 2):
            link = cells[3] if len(cells) > 3 else None
            video_id = cells[9] if len(cells) > 9 else None
            if isinstance(link, str) and link.strip() and not video_id:
                total += 1
                if len(pending) < limit:
                    pending.append({"row": index, "url": link.strip()})
        return {"rows": pending, "total": total}
    finally:
        workbook.close()


def _safe_cover_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 8192 or any(ord(c) < 32 for c in value):
        raise WorkbookExportError("封面地址格式无效。")
    try:
        url = urlsplit(value)
        host = (url.hostname or "").lower()
        allowed = any(host == domain or host.endswith("." + domain) for domain in COVER_DOMAINS)
        if url.scheme != "https" or not allowed or url.username or url.password or url.port not in (None, 443):
            raise WorkbookExportError("封面地址不属于允许的抖音图片域名。")
    except ValueError as exc:
        if isinstance(exc, WorkbookExportError):
            raise
        raise WorkbookExportError("封面地址格式无效。") from exc
    return value


class _CoverRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _safe_cover_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _cover_image(url: str) -> bytes:
    _safe_cover_url(url)
    request = Request(url, headers={
        "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
        "Referer": "https://www.douyin.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36",
    })
    with build_opener(_CoverRedirects()).open(request, timeout=15) as response:
        _safe_cover_url(response.geturl())
        content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
        if not content_type.startswith("image/"):
            raise WorkbookExportError("封面地址没有返回图片。")
        data = response.read(MAX_COVER_BYTES + 1)
        if len(data) > MAX_COVER_BYTES:
            raise WorkbookExportError("封面图片超过 6MB。")
    with PillowImage.open(BytesIO(data)) as image:
        if image.width * image.height > 20_000_000:
            raise WorkbookExportError("封面图片尺寸过大。")
        image.thumbnail((560, 760), PillowImage.Resampling.LANCZOS)
        output = BytesIO()
        image.convert("RGB").save(output, format="JPEG", quality=92, optimize=True)
        return output.getvalue()


def _text(cell, value):
    content = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(value or ""))
    if len(content) > 32767:
        raise WorkbookExportError("文本超过 Excel 单元格长度限制，请缩短内容后重试。")
    cell.value = content
    # Page text can begin with '='. It must remain text rather than an Excel formula.
    cell.data_type = "s"


def _count(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise WorkbookExportError("互动数据必须是非负整数，未知数据请留空。")
    return value


def _target_sheet(workbook, name: str):
    if name == "__new__":
        base = DEFAULT_SHEET
        candidate = base
        suffix = 2
        while candidate in workbook.sheetnames:
            candidate = f"{base}{suffix}"
            suffix += 1
        return workbook.create_sheet(candidate)
    if name not in workbook.sheetnames:
        raise WorkbookExportError("所选工作表不存在，请重新选择。")
    return workbook[name]


def _prepare_sheet(sheet):
    values = [sheet.cell(1, index).value for index in range(1, 12)]
    if all(value is None for value in values) and sheet.max_row == 1:
        for index, title in enumerate(HEADERS, 1):
            cell = sheet.cell(1, index, title)
            cell.fill = PatternFill("solid", fgColor="244E47")
            cell.font = Font(color="FFFFFF", bold=True)
            cell.alignment = Alignment(vertical="center")
        sheet.row_dimensions[1].height = 30
        sheet.freeze_panes = "A2"
        for col, width in {"A": 24, "B": 38, "C": 20, "D": 48, "E": 14, "F": 14, "G": 14, "H": 14, "I": 85, "K": 22}.items():
            sheet.column_dimensions[col].width = width
        sheet.column_dimensions["J"].hidden = True
    elif values[:10] == OLD_HEADERS and values[10] is None and all(sheet.cell(row, 11).value is None for row in range(2, sheet.max_row + 1)):
        cell = sheet.cell(1, 11, HEADERS[10])
        cell.fill = PatternFill("solid", fgColor="244E47")
        cell.font = Font(color="FFFFFF", bold=True)
        cell.alignment = Alignment(vertical="center")
        sheet.column_dimensions["K"].width = 22
        sheet.column_dimensions["J"].hidden = True
    elif values != HEADERS:
        raise WorkbookExportError("这张工作表的列与采集表不一致。请选择“新建工作表”，原有内容会保留。")

    if OPTIONS_SHEET in sheet.parent.sheetnames:
        options = sheet.parent[OPTIONS_SHEET]
        if options["A1"].value != "内容领域选项":
            raise WorkbookExportError("“内容领域选项”工作表已被其他内容占用，请另建一个 Excel 文件。")
    else:
        options = sheet.parent.create_sheet(OPTIONS_SHEET)
    options["A1"] = "内容领域选项"
    options["B1"] = "从 A2 往下填写选项；采集表的“内容领域”列即可下拉选择"
    options["A1"].font = Font(bold=True, color="FFFFFF")
    options["A1"].fill = PatternFill("solid", fgColor="244E47")
    options.column_dimensions["A"].width = 24
    options.column_dimensions["B"].width = 58
    options_reference = f"'{OPTIONS_SHEET}'!$A$2:$A${OPTIONS_LAST_ROW}"
    existing_name = sheet.parent.defined_names.get(OPTIONS_NAME)
    if existing_name and existing_name.attr_text != options_reference:
        raise WorkbookExportError("此文件已有同名的内容领域下拉列表，请另建一个 Excel 文件。")
    if not existing_name:
        sheet.parent.defined_names.add(DefinedName(OPTIONS_NAME, attr_text=options_reference))
    validation = next((item for item in sheet.data_validations.dataValidation if item.type == "list" and item.formula1 == f"={OPTIONS_NAME}"), None)
    if validation is None:
        validation = DataValidation(type="list", formula1=f"={OPTIONS_NAME}", allow_blank=True)
        validation.error = "请从“内容领域选项”工作表添加并选择一个领域。"
        validation.errorTitle = "内容领域"
        validation.showErrorMessage = True
        sheet.add_data_validation(validation)
    validation.add("K2:K10001")


def new_template() -> bytes:
    workbook = Workbook()
    try:
        workbook.active.title = DEFAULT_SHEET
        _prepare_sheet(workbook.active)
        output = BytesIO()
        workbook.save(output)
        return output.getvalue()
    finally:
        workbook.close()


def write_video(data: bytes, sheet_name: str, record: dict, *, cover_fetcher=_cover_image):
    video_id = str(record.get("videoId", ""))
    if not re.fullmatch(r"\d{1,24}", video_id):
        raise WorkbookExportError("视频 ID 无效，请重新读取抖音页面。")
    url = f"https://www.douyin.com/video/{video_id}"
    comments = str(record.get("topComments", ""))
    approximate = record.get("metricsApproximate") or {}
    if not isinstance(approximate, dict):
        raise WorkbookExportError("互动数据标记格式无效。")
    if len(comments) > 32767:
        raise WorkbookExportError("前 20 条评论超过 Excel 单元格长度限制，请减少评论文字后重试。")
    if not isinstance(sheet_name, str) or len(sheet_name) > 31:
        raise WorkbookExportError("工作表名称无效。")
    workbook = _load(data) if data else Workbook()
    try:
        if not data:
            workbook.active.title = DEFAULT_SHEET
        sheet = _target_sheet(workbook, sheet_name)
        _prepare_sheet(sheet)
        existing_row = next((index for index in range(2, sheet.max_row + 1) if str(sheet.cell(index, 10).value or "") == video_id), None)
        target_row = record.get("targetRow")
        if target_row is not None:
            if isinstance(target_row, bool) or not isinstance(target_row, int) or not 2 <= target_row <= sheet.max_row:
                raise WorkbookExportError("待采集行号无效，请重新读取表格。")
            if str(sheet.cell(target_row, 4).value or "").strip() != str(record.get("sourceLink") or "").strip():
                raise WorkbookExportError("待采集链接已变化，请重新读取表格。")
            target_id = str(sheet.cell(target_row, 10).value or "")
            if target_id and target_id != video_id:
                raise WorkbookExportError("这一行已经写入其他视频，请重新读取表格。")
            if existing_row and existing_row != target_row:
                raise WorkbookExportError("该视频已经存在于此表格的另一行，请删除重复链接后重试。")
            row = target_row
            action = "更新" if target_id else "新增"
        else:
            row = existing_row or sheet.max_row + 1
            action = "更新" if existing_row else "新增"
        cover_url = str(record.get("coverUrl") or "")
        _text(sheet.cell(row, 1), "查看封面" if cover_url else "未获取")
        if cover_url:
            _safe_cover_url(cover_url)
            sheet.cell(row, 1).hyperlink = cover_url
        else:
            sheet.cell(row, 1).hyperlink = None
        _text(sheet.cell(row, 2), record.get("title"))
        _text(sheet.cell(row, 3), record.get("author"))
        _text(sheet.cell(row, 4), url)
        sheet.cell(row, 4).hyperlink = url
        for column, key in [(5, "likes"), (6, "commentCount"), (7, "collectCount"), (8, "shareCount")]:
            cell = sheet.cell(row, column)
            cell.value = _count(record.get(key))
            cell.number_format = '"约 "#,##0' if approximate.get(key) else "#,##0"
        _text(sheet.cell(row, 9), comments)
        sheet.cell(row, 9).alignment = Alignment(wrap_text=True, vertical="top")
        _text(sheet.cell(row, 10), video_id)
        sheet.row_dimensions[row].height = 146
        sheet.auto_filter.ref = f"A1:K{sheet.max_row}"
        warnings_out = []
        # Existing cover drawings are replaced, including when the new page has no cover.
        sheet._images = [old for old in sheet._images if not (hasattr(old.anchor, "_from") and old.anchor._from.row == row - 1 and old.anchor._from.col == 0)]
        if cover_url:
            try:
                image_data = cover_fetcher(cover_url)
                image = WorkbookImage(BytesIO(image_data))
                if image.width < 160 or image.height < 160:
                    warnings_out.append("抖音返回的封面原图像素较低；可点击封面链接查看原图。")
                # Keep source pixels and place the drawing within the cover cell.
                scale = min(1, 140 / image.width, 190 / image.height)
                display_width = image.width * scale
                display_height = image.height * scale
                left = (173 - display_width) / 2
                top = (195 - display_height) / 2
                image.anchor = TwoCellAnchor(
                    editAs="twoCell",
                    _from=AnchorMarker(col=0, row=row - 1, colOff=pixels_to_EMU(left), rowOff=pixels_to_EMU(top)),
                    to=AnchorMarker(col=0, row=row - 1, colOff=pixels_to_EMU(left + display_width), rowOff=pixels_to_EMU(top + display_height)),
                )
                sheet.add_image(image)
            except Exception:
                warnings_out.append("封面缩略图未能下载；封面列保留了可点击的图片链接。")
        output = BytesIO()
        workbook.save(output)
        if output.tell() > MAX_WORKBOOK_BYTES:
            raise WorkbookExportError("写入后的 Excel 文件超过 25MB，请使用新文件。")
        return output.getvalue(), {"action": action, "row": row, "sheet": sheet.title, "warnings": warnings_out}
    finally:
        workbook.close()
