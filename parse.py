# -*- coding: utf-8 -*-
"""
parse.py —— 把教务系统导出的 PDF 课表，转成 data.js

为什么不能直接用 PyMuPDF / pdfplumber？
    这份 PDF 的字体是 Type0 + UniGB-UCS2-H，而且没有 ToUnicode 表，
    常规库抽出来是乱码。但正文其实就是 UTF-16BE 字节，
    所以我们自己解析内容流里的 Tj 字符串，反而最准。

PDF 的版面规律（实测）：
    · 7 个星期列，x 坐标落在固定区间里 —— 用它判断星期几
    · 同一门课的文字行，y 间距是 12 左右
    · 换一门课，y 间距会大于 20（同格内堆叠是 25.5）
    所以「按 y 间距切块」就能把每门课切出来。

用法:
    python parse.py 课表.pdf            # 生成 data.js
"""
import json
import re
import sys
import zlib
from pathlib import Path

# 一列一天，x 的区间边界（来自 PDF 的细线坐标）
COL_BOUNDS = [99.08, 202.92, 306.77, 410.62, 514.46, 618.31, 722.15, 10_000]

# 节次时间（学校默认作息；广学楼/明德楼的 3-4、7-8 节会提前 10/5 分钟）
PERIODS = [
    ("08:10", "08:55"), ("09:00", "09:45"),
    ("10:15", "11:00"), ("11:05", "11:50"),
    ("14:30", "15:15"), ("15:20", "16:05"),
    ("16:30", "17:15"), ("17:20", "18:05"),
    ("19:30", "20:15"), ("20:25", "21:10"),
]


# ---------- 第一步：从 PDF 里抠出「带坐标的文字」 ----------

def pdf_streams(data: bytes):
    for m in re.finditer(rb"stream\r?\n", data):
        start = m.end()
        end = data.find(b"endstream", start)
        if end > start:
            try:
                yield zlib.decompress(data[start:end])
            except zlib.error:      # 图片之类解不开的流，跳过
                continue


def unescape(raw: bytes) -> bytes:
    r"""处理 PDF 字符串里的 \( \) \\ 和八进制转义。"""
    out, i = bytearray(), 0
    mapping = {ord("n"): 10, ord("r"): 13, ord("t"): 9, ord("b"): 8,
               ord("f"): 12, ord("("): 40, ord(")"): 41, ord("\\"): 92}
    while i < len(raw):
        c = raw[i]
        if c == 0x5C and i + 1 < len(raw):          # 反斜杠
            n = raw[i + 1]
            if n in mapping:
                out.append(mapping[n]); i += 2; continue
            if 0x30 <= n <= 0x37:                    # \ooo
                j, digits = i + 1, b""
                while j < len(raw) and 0x30 <= raw[j] <= 0x37 and len(digits) < 3:
                    digits += bytes([raw[j]]); j += 1
                out.append(int(digits, 8) & 0xFF); i = j; continue
            i += 2; continue
        out.append(c); i += 1
    return bytes(out)


def text_items(content: bytes):
    """产出 (x, y, text)。text 按 UCS2 解码。"""
    pat = re.compile(
        rb"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm"
        rb"|\((?:[^()\\]|\\.)*\)\s*Tj"
    )
    x = y = 0.0
    for m in pat.finditer(content):
        tok = m.group(0)
        if tok.endswith(b"Tm"):
            x, y = float(m.group(5)), float(m.group(6))
            continue
        raw = unescape(tok[tok.index(b"(") + 1: tok.rindex(b")")])
        if len(raw) % 2:
            raw += b"\x00"
        text = raw.decode("utf-16-be", errors="replace").strip()
        if text:
            yield x, y, text


# ---------- 第二步：把文字按「天 / 课」重新组装 ----------

def day_of(x: float):
    for i in range(7):
        if COL_BOUNDS[i] <= x < COL_BOUNDS[i + 1]:
            return i + 1               # 1=周一 ... 7=周日
    return None


def split_entries(lines):
    """同一列的文字按 y 间距切成一门门课。

    实测：同一门课的行距是 12~13.5pt，换课至少 15.5pt。
    """
    entries, cur, prev_y = [], [], None
    for y, text in lines:
        if prev_y is not None and prev_y - y > 14:   # 间距变大 = 换课
            entries.append(cur); cur = []
        cur.append(text); prev_y = y
    if cur:
        entries.append(cur)
    return entries


def join_lines(lines):
    """中文换行直接拼；中文和英文/数字之间补一个空格，读起来不挤。"""
    out = ""
    for line in lines:
        if out and re.search(r"[\u4e00-\u9fff]$", out) and re.match(r"[A-Za-z0-9]", line):
            out += " "
        out += line
    return out


DETAIL_RE = re.compile(r"^\((\d+)-(\d+)节\)(.*)$")

# 表头里的干扰项：星期X、姓名+课表、学号
SKIP_RE = re.compile(r"^星期[一二三四五六日]$|课表$|^学号")


def parse_entry(lines, day):
    """一门课的文字行 → dict。返回 None 表示这行不是课（表头之类）。"""
    title, detail = [], []
    for line in lines:
        if DETAIL_RE.match(line) or detail:
            detail.append(line)
        else:
            title.append(line)
    if not detail:
        return None
    name = join_lines(title)
    m = DETAIL_RE.match(detail[0])
    if not m:
        return None
    start, end = int(m.group(1)), int(m.group(2))

    # 换行会把教室名拆开，拼回去
    rest = "".join([m.group(3)] + detail[1:])
    week_part, _, tail = rest.partition("/校区:")
    campus, _, place = tail.partition("/场地:")

    online = name.startswith("(网络课)")
    name = name.replace("(网络课)", "").rstrip("*$").strip()

    return {
        "name": name,
        "day": day,
        "start": start,
        "end": end,
        "weeks": parse_weeks(week_part),
        "place": place.strip(),
        "campus": campus.strip(),
        "online": online,
    }


def parse_weeks(text: str):
    """'2-8周(双),12-16周(双)' → [2,4,6,8,12,14,16]"""
    weeks = []
    for token in text.split(","):
        token = token.strip().replace("第", "")
        parity = None
        if "(单)" in token:
            parity = 1
        elif "(双)" in token:
            parity = 0
        token = re.sub(r"\((单|双)\)", "", token).rstrip("周")
        m = re.match(r"^(\d+)-(\d+)$", token)
        if m:
            lo, hi = int(m.group(1)), int(m.group(2))
            weeks += [w for w in range(lo, hi + 1)
                      if parity is None or w % 2 == parity]
        elif token.isdigit():
            weeks.append(int(token))
    return sorted(set(weeks))


def main(pdf_path: str):
    data = Path(pdf_path).read_bytes()

    all_lines = {}          # day -> [(y, text)]
    for content in pdf_streams(data):
        for x, y, text in text_items(content):
            if SKIP_RE.match(text):         # 表头、姓名学号之类
                continue
            day = day_of(x)
            if day:
                all_lines.setdefault(day, []).append((y, text))

    courses = []
    for day in sorted(all_lines):
        lines = sorted(all_lines[day], key=lambda t: -t[0])   # 从上到下
        for block in split_entries(lines):
            course = parse_entry(block, day)
            if course:
                courses.append(course)

    meta = {
        "term": "2026-2027-1",
        "week1": "2026-08-31",          # 第 1 周的周一
        "totalWeeks": 20,
        "periods": PERIODS,
    }
    out = Path(__file__).with_name("data.js")
    out.write_text(
        "// 由 parse.py 自动生成，不要手改；改课表就重跑 parse.py\n"
        f"window.META = {json.dumps(meta, ensure_ascii=False)};\n"
        f"window.COURSES = {json.dumps(courses, ensure_ascii=False, indent=1)};\n",
        encoding="utf-8",
    )
    print(f"解析出 {len(courses)} 条课程记录 → {out}")
    for c in courses:
        print(f"  周{c['day']} {c['start']}-{c['end']}节 {c['name']} "
              f"@ {c['place']} 周次 {c['weeks']}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "课表.pdf")
