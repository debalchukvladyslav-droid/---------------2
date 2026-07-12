#!/usr/bin/env python3
"""
Experimental importer for messy trader Google Sheets.

This script does not touch the app's existing import flow. It connects to the
official Google Sheets API with a service account, detects a multi-row header,
handles merged header cells, maps known aliases to canonical trade fields, and
exports normalized rows as JSON or CSV.

Install dependencies:
    python -m pip install google-api-python-client google-auth

Run example:
    python scripts/unstructured_google_sheet_import.py ^
      --spreadsheet-id "1abc..." ^
      --sheet "Trader Ivan" ^
      --service-account-file ".secrets/google-service-account.json" ^
      --output out/trades.json

The Google Sheet must be shared with the service account client_email.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
except ModuleNotFoundError as exc:
    missing = exc.name or "google-api-python-client"
    sys.stderr.write(
        f"Missing Python dependency: {missing}\n"
        "Install dependencies with:\n"
        "  python -m pip install -r scripts/requirements-google-sheets-import.txt\n"
    )
    raise SystemExit(4)


SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
DEFAULT_SCAN_ROWS = 20
DEFAULT_MAX_ROWS = 5000
DEFAULT_MAX_COLS = 702  # A:ZZ

ALIASES: Dict[str, List[str]] = {
    "date": [
        "Дата",
        "date",
        "trade date",
        "дата угоди",
        "час",
        "time",
        "opened",
        "open time",
    ],
    "ticker": [
        "Ticker",
        "тікер",
        "тикер",
        "Символ",
        "symbol",
        "instrument",
        "asset",
    ],
    "trade_type": [
        "Тип сдєлки",
        "Тип сделки",
        "Тип угоди",
        "trade type",
        "type",
        "side",
        "direction",
        "buy/sell",
    ],
    "profit": [
        "Профіт факт",
        "Профіт",
        "прибуток",
        "profit",
        "p&l",
        "pnl",
        "net pnl",
        "realized pnl",
    ],
    "quantity": [
        "Кількість",
        "Кол-во",
        "qty",
        "quantity",
        "shares",
        "size",
    ],
    "entry_price": [
        "Entry",
        "Entry Price",
        "ціна входу",
        "open price",
        "avg price",
        "price",
    ],
    "exit_price": [
        "Exit",
        "Exit Price",
        "ціна виходу",
        "close price",
        "close",
    ],
    "commission": [
        "Commission",
        "Commissions",
        "комісія",
        "комиссия",
        "fees",
        "fee",
    ],
}

MANDATORY_FIELDS = ["date", "ticker", "profit"]


class ImportErrorWithHint(RuntimeError):
    """Readable import error for CLI output."""


@dataclass(frozen=True)
class HeaderCandidate:
    top_row: int
    bottom_row: int
    headers: List[str]
    field_indexes: Dict[str, int]
    score: int


def normalize_text(value: Any) -> str:
    """Normalize text for robust alias comparison."""
    text = str(value or "").strip().casefold()
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.replace("є", "е").replace("ё", "е").replace("ї", "і")
    text = re.sub(r"[\s\n\r\t_/\\\-]+", " ", text)
    text = re.sub(r"[^\w&.%+ ]+", "", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", text).strip()


def col_to_a1(col_index: int) -> str:
    """Convert zero-based column index to A1 column letters."""
    col = col_index + 1
    letters = ""
    while col:
        col, rem = divmod(col - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def quote_sheet_name(title: str) -> str:
    return "'" + title.replace("'", "''") + "'"


def pad_grid(rows: List[List[str]], width: int) -> List[List[str]]:
    return [row + [""] * max(0, width - len(row)) for row in rows]


def cell_to_text(cell: Dict[str, Any]) -> str:
    if "formattedValue" in cell:
        return str(cell.get("formattedValue") or "").strip()
    effective = cell.get("effectiveValue") or cell.get("userEnteredValue") or {}
    for key in ("stringValue", "numberValue", "boolValue"):
        if key in effective:
            return str(effective[key]).strip()
    return ""


def load_service_account(path: Optional[str]):
    raw_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
    if raw_json:
        info = json.loads(raw_json)
        return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    if not path:
        raise ImportErrorWithHint(
            "Missing service account. Pass --service-account-file or set GOOGLE_SERVICE_ACCOUNT_JSON."
        )
    return service_account.Credentials.from_service_account_file(path, scopes=SCOPES)


def sheets_service(credentials):
    return build("sheets", "v4", credentials=credentials, cache_discovery=False)


def first_sheet_title(service, spreadsheet_id: str) -> str:
    meta = service.spreadsheets().get(
        spreadsheetId=spreadsheet_id,
        fields="sheets(properties(title))",
    ).execute()
    sheets = meta.get("sheets") or []
    if not sheets:
        raise ImportErrorWithHint("Spreadsheet has no sheets.")
    return sheets[0]["properties"]["title"]


def fetch_header_grid(
    service,
    spreadsheet_id: str,
    sheet_title: str,
    scan_rows: int,
    max_cols: int,
) -> List[List[str]]:
    """Fetch first rows with merge metadata and fill merged header values."""
    end_col = col_to_a1(max_cols - 1)
    a1_range = f"{quote_sheet_name(sheet_title)}!A1:{end_col}{scan_rows}"
    response = service.spreadsheets().get(
        spreadsheetId=spreadsheet_id,
        ranges=[a1_range],
        includeGridData=True,
        fields="sheets(data(rowData(values(formattedValue,effectiveValue,userEnteredValue))),merges)",
    ).execute()

    sheet = (response.get("sheets") or [{}])[0]
    data = (sheet.get("data") or [{}])[0]
    row_data = data.get("rowData") or []

    grid: List[List[str]] = []
    for row in row_data[:scan_rows]:
        values = row.get("values") or []
        grid.append([cell_to_text(cell) for cell in values[:max_cols]])
    while len(grid) < scan_rows:
        grid.append([])
    grid = pad_grid(grid, max_cols)

    for merge in sheet.get("merges") or []:
        sr = int(merge.get("startRowIndex", 0))
        er = int(merge.get("endRowIndex", sr + 1))
        sc = int(merge.get("startColumnIndex", 0))
        ec = int(merge.get("endColumnIndex", sc + 1))
        if sr >= scan_rows or sc >= max_cols:
            continue
        value = grid[sr][sc] if sr < len(grid) and sc < len(grid[sr]) else ""
        if not value:
            continue
        for r in range(sr, min(er, scan_rows)):
            for c in range(sc, min(ec, max_cols)):
                if not grid[r][c]:
                    grid[r][c] = value
    return grid


def fetch_values(
    service,
    spreadsheet_id: str,
    sheet_title: str,
    max_rows: int,
    max_cols: int,
) -> List[List[str]]:
    end_col = col_to_a1(max_cols - 1)
    a1_range = f"{quote_sheet_name(sheet_title)}!A1:{end_col}{max_rows}"
    response = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id,
        range=a1_range,
        majorDimension="ROWS",
        valueRenderOption="FORMATTED_VALUE",
        dateTimeRenderOption="FORMATTED_STRING",
    ).execute()
    rows = [[str(cell).strip() for cell in row] for row in response.get("values", [])]
    return pad_grid(rows, max_cols)


def alias_patterns() -> Dict[str, List[str]]:
    return {field: [normalize_text(alias) for alias in aliases] for field, aliases in ALIASES.items()}


def header_matches_field(header: str, aliases: Sequence[str]) -> bool:
    norm = normalize_text(header)
    if not norm:
        return False
    return any(alias == norm or alias in norm or norm in alias for alias in aliases)


def flatten_headers(grid: List[List[str]], top: int, bottom: int, max_cols: int) -> List[str]:
    """Flatten multiple header rows into one column-name list."""
    headers: List[str] = []
    for col in range(max_cols):
        parts: List[str] = []
        for row in range(top, bottom + 1):
            value = grid[row][col].strip() if row < len(grid) and col < len(grid[row]) else ""
            if value and (not parts or normalize_text(parts[-1]) != normalize_text(value)):
                parts.append(value)
        headers.append(" ".join(parts).strip())
    return headers


def map_fields(headers: Sequence[str]) -> Dict[str, int]:
    patterns = alias_patterns()
    mapped: Dict[str, int] = {}
    for field, aliases in patterns.items():
        best: Optional[Tuple[int, int]] = None
        for idx, header in enumerate(headers):
            if header_matches_field(header, aliases):
                normalized_len = len(normalize_text(header))
                candidate = (normalized_len, idx)
                if best is None or candidate < best:
                    best = candidate
        if best is not None:
            mapped[field] = best[1]
    return mapped


def row_alias_score(row: Sequence[str]) -> int:
    patterns = alias_patterns()
    score = 0
    for cell in row:
        for aliases in patterns.values():
            if header_matches_field(cell, aliases):
                score += 1
                break
    return score


def detect_header(
    header_grid: List[List[str]],
    max_cols: int,
    mandatory_fields: Sequence[str],
) -> HeaderCandidate:
    """Find the best header block without hardcoding row numbers."""
    candidates: List[HeaderCandidate] = []
    scan_rows = len(header_grid)

    anchor_rows = [
        idx for idx, row in enumerate(header_grid)
        if row_alias_score(row) > 0
    ]
    if not anchor_rows:
        raise ImportErrorWithHint(
            "Could not detect a header row. Add aliases or check that first rows contain Date/Ticker/Profit headers."
        )

    for anchor in anchor_rows:
        for top in range(max(0, anchor - 2), anchor + 1):
            for bottom in range(anchor, min(scan_rows - 1, anchor + 2) + 1):
                headers = flatten_headers(header_grid, top, bottom, max_cols)
                mapped = map_fields(headers)
                mandatory_hits = sum(1 for field in mandatory_fields if field in mapped)
                total_hits = len(mapped)
                non_empty = sum(1 for h in headers if h.strip())
                score = mandatory_hits * 100 + total_hits * 10 - (bottom - top) - min(non_empty, 30)
                if mandatory_hits:
                    candidates.append(HeaderCandidate(top, bottom, headers, mapped, score))

    if not candidates:
        raise ImportErrorWithHint("Header candidates were found, but no aliases matched required fields.")

    best = max(candidates, key=lambda item: item.score)
    missing = [field for field in mandatory_fields if field not in best.field_indexes]
    if missing:
        pretty = ", ".join(missing)
        found = ", ".join(f"{field}={col_to_a1(idx)}" for field, idx in best.field_indexes.items())
        raise ImportErrorWithHint(f"Mandatory columns not found: {pretty}. Detected: {found or 'none'}.")
    return best


def parse_number(value: Any) -> Optional[float]:
    text = str(value or "").strip()
    if not text:
        return None
    text = text.replace("\u00a0", " ")
    text = re.sub(r"[^\d,.\-+()]", "", text)
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    text = text.strip("()")

    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif "," in text:
        text = text.replace(",", ".")

    try:
        number = float(text)
    except ValueError:
        return None
    return -abs(number) if negative else number


def parse_date(value: Any, default_year: Optional[int] = None) -> Optional[str]:
    text = str(value or "").strip()
    if not text:
        return None
    text = re.sub(r"\s+\d{1,2}:\d{2}(:\d{2})?$", "", text)

    formats = [
        "%Y-%m-%d",
        "%d.%m.%Y",
        "%d.%m.%y",
        "%d/%m/%Y",
        "%d/%m/%y",
        "%d-%m-%Y",
        "%d-%m-%y",
        "%m/%d/%Y",
        "%m/%d/%y",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass

    compact = re.match(r"^(\d{1,2})[./-](\d{1,2})$", text)
    if compact and default_year:
        day, month = int(compact.group(1)), int(compact.group(2))
        try:
            return date(default_year, month, day).isoformat()
        except ValueError:
            return None

    # Google Sheets may expose serial dates if the source cell was numeric.
    number = parse_number(text)
    if number and 20000 <= number <= 80000:
        origin = datetime(1899, 12, 30)
        return (origin + timedelta(days=int(number))).date().isoformat()
    return None


def is_probably_empty(row: Sequence[str], mapped_indexes: Iterable[int]) -> bool:
    return not any((row[idx].strip() if idx < len(row) else "") for idx in mapped_indexes)


def normalize_trade_row(row: Sequence[str], field_indexes: Dict[str, int], default_year: Optional[int]) -> Dict[str, Any]:
    def raw(field: str) -> str:
        idx = field_indexes.get(field)
        return row[idx].strip() if idx is not None and idx < len(row) else ""

    return {
        "date": parse_date(raw("date"), default_year),
        "ticker": raw("ticker").upper(),
        "trade_type": raw("trade_type"),
        "profit": parse_number(raw("profit")),
        "quantity": parse_number(raw("quantity")),
        "entry_price": parse_number(raw("entry_price")),
        "exit_price": parse_number(raw("exit_price")),
        "commission": parse_number(raw("commission")),
        "raw": {
            field: raw(field)
            for field in field_indexes
        },
    }


def extract_rows(
    values: List[List[str]],
    header: HeaderCandidate,
    default_year: Optional[int],
) -> List[Dict[str, Any]]:
    output: List[Dict[str, Any]] = []
    mapped_indexes = set(header.field_indexes.values())
    start_row = header.bottom_row + 1

    for row_number, row in enumerate(values[start_row:], start=start_row + 1):
        if is_probably_empty(row, mapped_indexes):
            continue
        normalized = normalize_trade_row(row, header.field_indexes, default_year)
        if not normalized["date"] and not normalized["ticker"] and normalized["profit"] is None:
            continue
        normalized["source_row"] = row_number
        output.append(normalized)
    return output


def write_output(rows: List[Dict[str, Any]], output_path: Optional[str]) -> None:
    if not output_path:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return

    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() == ".csv":
        fields = ["source_row", "date", "ticker", "trade_type", "profit", "quantity", "entry_price", "exit_price", "commission"]
        with path.open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            for row in rows:
                writer.writerow({field: row.get(field) for field in fields})
    else:
        path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Normalize messy trader Google Sheets.")
    parser.add_argument("--spreadsheet-id", required=True, help="Google Spreadsheet ID.")
    parser.add_argument("--sheet", help="Sheet/tab title. Defaults to first sheet.")
    parser.add_argument("--service-account-file", help="Path to service account JSON.")
    parser.add_argument("--output", help="Output .json or .csv path. Defaults to stdout.")
    parser.add_argument("--scan-rows", type=int, default=DEFAULT_SCAN_ROWS, help="Rows to scan for headers.")
    parser.add_argument("--max-rows", type=int, default=DEFAULT_MAX_ROWS, help="Max rows to fetch.")
    parser.add_argument("--max-cols", type=int, default=DEFAULT_MAX_COLS, help="Max columns to fetch.")
    parser.add_argument("--default-year", type=int, help="Year for compact dates like 15.06.")
    args = parser.parse_args(argv)

    try:
        credentials = load_service_account(args.service_account_file)
        service = sheets_service(credentials)
        sheet_title = args.sheet or first_sheet_title(service, args.spreadsheet_id)
        header_grid = fetch_header_grid(
            service,
            args.spreadsheet_id,
            sheet_title,
            max(1, args.scan_rows),
            max(1, args.max_cols),
        )
        header = detect_header(header_grid, max(1, args.max_cols), MANDATORY_FIELDS)
        values = fetch_values(service, args.spreadsheet_id, sheet_title, max(1, args.max_rows), max(1, args.max_cols))
        rows = extract_rows(values, header, args.default_year)

        sys.stderr.write(
            f"Detected header rows {header.top_row + 1}-{header.bottom_row + 1}; "
            f"columns: {', '.join(f'{k}={col_to_a1(v)}' for k, v in sorted(header.field_indexes.items()))}; "
            f"rows: {len(rows)}\n"
        )
        write_output(rows, args.output)
        return 0
    except ImportErrorWithHint as exc:
        sys.stderr.write(f"Import error: {exc}\n")
        return 2
    except HttpError as exc:
        sys.stderr.write(f"Google API error: {exc}\n")
        return 3
    except Exception as exc:
        sys.stderr.write(f"Unexpected error: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
