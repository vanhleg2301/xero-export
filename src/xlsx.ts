import { createZip, type ZipEntry } from "./zip";

export interface SheetImage {
  row: number; // 0-based index into rows
  column: number; // 0-based column index
  data: Buffer;
  extension: "png" | "jpeg";
}

export interface SheetLink {
  row: number; // 0-based index into rows, -1 for the header
  column: number;
  target: string; // relative or absolute path/URL
}

export interface SheetSpec {
  name: string;
  columns: string[];
  rows: string[][];
  links?: SheetLink[];
  images?: SheetImage[];
  imageRowHeight?: number;
}

const EMU_PER_PIXEL = 9525;
const DEFAULT_IMAGE_HEIGHT_PX = 120;
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

const escapeXml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] as string)
    // Control characters are not valid in XML 1.0 and make Excel refuse the file.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

export function getColumnName(index: number): string {
  let name = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) name = String.fromCharCode(65 + (n % 26)) + name;
  return name;
}

function getSheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31).trim() || "Sheet";
  let result = base;
  for (let n = 2; used.has(result.toLowerCase()); n++) result = `${base.slice(0, 28)} ${n}`;
  used.add(result.toLowerCase());
  return result;
}

// Minimal PNG/JPEG header parsing, only to keep the aspect ratio of embedded thumbnails.
function getImageSize(data: Buffer): { width: number; height: number } {
  if (data.readUInt32BE(0) === 0x89504e47) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  for (let offset = 2; offset + 9 < data.length && data[offset] === 0xff; ) {
    const marker = data[offset + 1];
    const length = data.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { width: DEFAULT_IMAGE_HEIGHT_PX, height: DEFAULT_IMAGE_HEIGHT_PX };
}

function renderCell(ref: string, value: string, styleId: number): string {
  if (value === "") return "";
  const style = styleId > 0 ? ` s="${styleId}"` : "";
  if (NUMBER_PATTERN.test(value) && value.length < 15) return `<c r="${ref}"${style}><v>${value}</v></c>`;
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function renderSheet(sheet: SheetSpec, linkIds: Map<string, string>, hasDrawing: boolean): string {
  const imageRows = new Set((sheet.images ?? []).map((image) => image.row));
  const rowHeight = sheet.imageRowHeight ?? DEFAULT_IMAGE_HEIGHT_PX * 0.75 + 6;

  const widths = sheet.columns.map((header, i) => {
    const longest = sheet.rows.reduce((max, row) => Math.max(max, (row[i] ?? "").length), header.length);
    return Math.min(Math.max(longest + 2, 9), 55);
  });

  const headerCells = sheet.columns.map((header, i) => renderCell(`${getColumnName(i)}1`, header, 1)).join("");
  const bodyRows = sheet.rows
    .map((row, r) => {
      const rowNumber = r + 2;
      const cells = row.map((value, c) => renderCell(`${getColumnName(c)}${rowNumber}`, value, 0)).join("");
      const height = imageRows.has(r) ? ` ht="${rowHeight}" customHeight="1"` : "";
      return `<row r="${rowNumber}"${height}>${cells}</row>`;
    })
    .join("");

  const hyperlinks = [...linkIds]
    .map(([ref, id]) => `<hyperlink ref="${ref}" r:id="${id}"/>`)
    .join("");

  return `${XML_HEADER}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>
<sheetData><row r="1">${headerCells}</row>${bodyRows}</sheetData>
${sheet.columns.length > 0 && sheet.rows.length > 0 ? `<autoFilter ref="A1:${getColumnName(sheet.columns.length - 1)}${sheet.rows.length + 1}"/>` : ""}
${hyperlinks ? `<hyperlinks>${hyperlinks}</hyperlinks>` : ""}
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
${hasDrawing ? '<drawing r:id="rIdDrawing"/>' : ""}
</worksheet>`;
}

function renderDrawing(images: SheetImage[]): string {
  const anchors = images
    .map((image, i) => {
      const { width, height } = getImageSize(image.data);
      const scaledHeight = DEFAULT_IMAGE_HEIGHT_PX;
      const scaledWidth = Math.max(16, Math.round((width / height) * scaledHeight));
      const cx = scaledWidth * EMU_PER_PIXEL;
      const cy = scaledHeight * EMU_PER_PIXEL;
      return `<xdr:oneCellAnchor>
<xdr:from><xdr:col>${image.column}</xdr:col><xdr:colOff>19050</xdr:colOff><xdr:row>${image.row + 1}</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>
<xdr:ext cx="${cx}" cy="${cy}"/>
<xdr:pic>
<xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="Picture ${i + 2}"/><xdr:cNvPicPr/></xdr:nvPicPr>
<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImage${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic>
<xdr:clientData/>
</xdr:oneCellAnchor>`;
    })
    .join("");

  return `${XML_HEADER}
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`;
}

const STYLES = `${XML_HEADER}
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export function buildXlsx(sheets: SheetSpec[]): Buffer {
  const entries: ZipEntry[] = [];
  const add = (name: string, content: string | Buffer) =>
    entries.push({ name, data: typeof content === "string" ? Buffer.from(content, "utf8") : content });

  const usedNames = new Set<string>();
  const sheetNames = sheets.map((sheet) => getSheetName(sheet.name, usedNames));
  const overrides: string[] = [];
  const imageExtensions = new Set<string>();

  sheets.forEach((sheet, index) => {
    const sheetNumber = index + 1;
    const images = sheet.images ?? [];
    const rels: string[] = [];

    const linkIds = new Map<string, string>();
    (sheet.links ?? []).forEach((link, i) => {
      const id = `rIdLink${i + 1}`;
      const ref = `${getColumnName(link.column)}${link.row + 2}`;
      linkIds.set(ref, id);
      const target = link.target.split("/").map(encodeURIComponent).join("/");
      rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(target)}" TargetMode="External"/>`);
    });

    if (images.length > 0) {
      rels.push(`<Relationship Id="rIdDrawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${sheetNumber}.xml"/>`);
      const imageRels = images.map((image, i) => {
        const fileName = `image${sheetNumber}_${i + 1}.${image.extension}`;
        imageExtensions.add(image.extension);
        add(`xl/media/${fileName}`, image.data);
        return `<Relationship Id="rIdImage${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${fileName}"/>`;
      });
      add(`xl/drawings/drawing${sheetNumber}.xml`, renderDrawing(images));
      add(
        `xl/drawings/_rels/drawing${sheetNumber}.xml.rels`,
        `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${imageRels.join("")}</Relationships>`,
      );
      overrides.push(`<Override PartName="/xl/drawings/drawing${sheetNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
    }

    add(`xl/worksheets/sheet${sheetNumber}.xml`, renderSheet(sheet, linkIds, images.length > 0));
    if (rels.length > 0) {
      add(
        `xl/worksheets/_rels/sheet${sheetNumber}.xml.rels`,
        `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
      );
    }
    overrides.push(`<Override PartName="/xl/worksheets/sheet${sheetNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  });

  add(
    "[Content_Types].xml",
    `${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${[...imageExtensions].map((ext) => `<Default Extension="${ext}" ContentType="image/${ext}"/>`).join("")}
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${overrides.join("")}
</Types>`,
  );

  add(
    "_rels/.rels",
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );

  add(
    "xl/workbook.xml",
    `${XML_HEADER}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetNames.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rIdSheet${i + 1}"/>`).join("")}</sheets>
</workbook>`,
  );

  add(
    "xl/_rels/workbook.xml.rels",
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetNames.map((_, i) => `<Relationship Id="rIdSheet${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );

  add("xl/styles.xml", STYLES);

  return createZip(entries);
}
