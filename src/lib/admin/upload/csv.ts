/**
 * CSV helpers for the instruction import. The reader only accepts a header
 * with instruction and response (or output) columns. input and source are
 * optional. Quoted commas and quoted newlines are supported.
 */

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

export type CsvLayout = {
  instruction: number;
  response: number;
  input: number | null;
  source: number | null;
};

export type CsvRecordRange = {
  contentStart: number;
  contentEnd: number;
  next: number;
};

/**
 * Finds one CSV record in a byte window. A newline outside quotes ends the
 * record. A quote only opens a quoted field at the start of a field.
 */
export function findCsvRecord(
  bytes: Uint8Array,
  start: number,
): CsvRecordRange {
  let index = start;
  let inQuotes = false;
  let fieldStart = true;

  while (index < bytes.length) {
    const byte = bytes[index];

    if (inQuotes) {
      if (byte === 0x22) {
        if (index + 1 < bytes.length && bytes[index + 1] === 0x22) {
          index += 2;
          continue;
        }
        inQuotes = false;
        fieldStart = false;
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }

    if (byte === 0x0a) {
      return {
        contentStart: start,
        contentEnd: index,
        next: index + 1,
      };
    }

    if (byte === 0x22 && fieldStart) {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (byte === 0x2c) {
      fieldStart = true;
      index += 1;
      continue;
    }

    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) {
      fieldStart = false;
    }

    index += 1;
  }

  if (inQuotes) {
    throw new CsvError("A quoted CSV field is not closed.");
  }

  return {
    contentStart: start,
    contentEnd: bytes.length,
    next: bytes.length,
  };
}

/** Parses one CSV record into fields. */
export function parseCsvRecord(record: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true;

  for (let index = 0; index < record.length; index += 1) {
    const char = record[index];

    if (inQuotes) {
      if (char === '"') {
        if (record[index + 1] === '"') {
          field += '"';
          index += 1;
          continue;
        }
        inQuotes = false;
        fieldStart = false;
        continue;
      }
      field += char;
      continue;
    }

    if (char === '"' && fieldStart) {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      fields.push(field);
      field = "";
      fieldStart = true;
      continue;
    }

    if (char === "\r" && index === record.length - 1) {
      continue;
    }

    field += char;
    if (char !== " " && char !== "\t") {
      fieldStart = false;
    }
  }

  if (inQuotes) {
    throw new CsvError("A quoted CSV field is not closed.");
  }

  fields.push(field);
  return fields;
}

/** Reads the header row and returns the column positions. */
export function parseCsvHeader(header: string[]): CsvLayout {
  const names = header.map((name) =>
    name.replace(/^\uFEFF/, "").trim().toLowerCase(),
  );

  const instruction = names.indexOf("instruction");
  let response = names.indexOf("response");
  if (response === -1) response = names.indexOf("output");

  if (instruction === -1 || response === -1) {
    throw new CsvError(
      "CSV needs an instruction column and a response (or output) column.",
    );
  }

  const input = names.indexOf("input");
  const source = names.indexOf("source");

  return {
    instruction,
    response,
    input: input === -1 ? null : input,
    source: source === -1 ? null : source,
  };
}

/**
 * Converts one CSV record into the JSON string the server validates. Missing
 * or empty fields are left out; the server then reports the real reason.
 */
export function csvRecordToRaw(record: string, layout: CsvLayout): string {
  const fields = parseCsvRecord(record);
  const row: Record<string, string> = {};

  const instruction = fields[layout.instruction]?.trim();
  if (instruction) row.instruction = instruction;

  const response = fields[layout.response]?.trim();
  if (response) row.response = response;

  if (layout.input !== null) {
    const input = fields[layout.input]?.trim();
    if (input) row.input = input;
  }

  if (layout.source !== null) {
    const source = fields[layout.source]?.trim();
    if (source) row.source = source;
  }

  return JSON.stringify(row);
}

/** Quotes one CSV cell and neutralises spreadsheet formulas. */
export function csvCell(value: string): string {
  const dangerous = /^[=+\-@]/.test(value);
  const text = dangerous ? `'${value}` : value;
  return `"${text.replace(/"/g, '""')}"`;
}

export type ErrorCsvRow = {
  rowIndex: number;
  reason: string;
  detail: string | null;
};

/** Builds the downloadable error report. Cells are always quoted. */
export function buildErrorCsv(rows: readonly ErrorCsvRow[]): string {
  const lines = ["row_index,reason,detail"];
  for (const row of rows) {
    lines.push(
      [
        csvCell(String(row.rowIndex)),
        csvCell(row.reason),
        csvCell(row.detail ?? ""),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
