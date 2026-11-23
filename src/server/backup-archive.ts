/**
 * Zero-dependency POSIX ustar + PAX `.tar.gz` archiver/extractor.
 *
 * Uses only Node's built-in `node:zlib` and `Buffer`, works identically on
 * Windows, Linux, and macOS, supports UTF-8 and long paths via PAX extended
 * headers, and enforces strict safety bounds on extraction (no symlinks,
 * no absolute paths, no `..` traversal, bounded entry count and byte size).
 */

import zlib from "node:zlib";
import { isValidBundleRelativePath } from "../core/contracts/migration.ts";

export interface TarEntry {
	path: string;
	bytes: Buffer;
	mtimeMs?: number;
}

export interface UnpackTarOptions {
	maxEntries?: number;
	maxTotalBytes?: number;
}

const BLOCK_SIZE = 512;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 256 MiB uncompressed cap

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
	const oct = Math.max(0, Math.floor(value)).toString(8);
	const padded = oct.padStart(length - 1, "0").slice(-(length - 1));
	buf.write(padded, offset, length - 1, "ascii");
	buf[offset + length - 1] = 0;
}

function parseOctal(buf: Buffer, offset: number, length: number): number {
	const raw = buf.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/, "").trim();
	if (!raw) return 0;
	const parsed = Number.parseInt(raw, 8);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

function readCString(buf: Buffer, offset: number, length: number): string {
	const slice = buf.subarray(offset, offset + length);
	const nul = slice.indexOf(0);
	return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8");
}

function buildHeaderBlock(name: string, size: number, mtimeSec: number, typeflag: string, prefix = ""): Buffer {
	const header = Buffer.alloc(BLOCK_SIZE, 0);
	header.write(name.slice(0, 100), 0, 100, "utf8");
	writeOctal(header, 100, 8, 0o644);
	writeOctal(header, 108, 8, 0);
	writeOctal(header, 116, 8, 0);
	writeOctal(header, 124, 12, size);
	writeOctal(header, 136, 12, mtimeSec);
	// Checksum placeholder: 8 ASCII spaces
	header.fill(0x20, 148, 156);
	header.write(typeflag, 156, 1, "ascii");
	header.write("ustar\0", 257, 6, "ascii");
	header.write("00", 263, 2, "ascii");
	if (prefix) {
		header.write(prefix.slice(0, 155), 345, 155, "utf8");
	}
	let checksum = 0;
	for (let i = 0; i < BLOCK_SIZE; i++) checksum += header[i]!;
	const chkStr = checksum.toString(8).padStart(6, "0");
	header.write(chkStr, 148, 6, "ascii");
	header[154] = 0;
	header[155] = 0x20;
	return header;
}

function encodePaxRecord(key: string, value: string): Buffer {
	const body = ` ${key}=${value}\n`;
	const bodyBytes = Buffer.byteLength(body, "utf8");
	let len = bodyBytes + 1;
	while (true) {
		const total = Buffer.byteLength(String(len), "ascii") + bodyBytes;
		if (total === len) break;
		len = total;
	}
	return Buffer.from(`${len}${body}`, "utf8");
}

function parsePaxRecords(data: Buffer): Record<string, string> {
	const result: Record<string, string> = {};
	const text = data.toString("utf8");
	let pos = 0;
	while (pos < text.length) {
		const space = text.indexOf(" ", pos);
		if (space === -1) break;
		const len = Number.parseInt(text.slice(pos, space), 10);
		if (!Number.isFinite(len) || len <= 0) break;
		// Length is in UTF-8 bytes; compute exact byte slice from original buffer.
		const byteOffset = Buffer.byteLength(text.slice(0, pos), "utf8");
		const recordText = data.subarray(byteOffset, byteOffset + len).toString("utf8");
		const eq = recordText.indexOf("=");
		const sp = recordText.indexOf(" ");
		if (sp !== -1 && eq > sp) {
			const k = recordText.slice(sp + 1, eq);
			const v = recordText.slice(eq + 1).replace(/\n$/, "");
			result[k] = v;
		}
		pos += recordText.length;
	}
	return result;
}

function isAsciiPrintable(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}

function padToBlock(size: number): Buffer | null {
	const rem = size % BLOCK_SIZE;
	return rem === 0 ? null : Buffer.alloc(BLOCK_SIZE - rem, 0);
}

export function packTarGz(entries: readonly TarEntry[]): Buffer {
	const chunks: Buffer[] = [];
	const seen = new Set<string>();

	for (const entry of entries) {
		const relPath = entry.path.replace(/\\/g, "/");
		if (!isValidBundleRelativePath(relPath)) {
			throw new Error(`Invalid archive entry path: ${entry.path}`);
		}
		if (seen.has(relPath)) {
			throw new Error(`Duplicate archive entry path: ${relPath}`);
		}
		seen.add(relPath);

		const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes);
		const mtimeSec = Math.floor((entry.mtimeMs ?? Date.now()) / 1000);
		const needsPax = !isAsciiPrintable(relPath) || Buffer.byteLength(relPath, "utf8") > 100;

		if (needsPax) {
			const paxData = encodePaxRecord("path", relPath);
			chunks.push(buildHeaderBlock(`PaxHeader/${seen.size}`, paxData.length, mtimeSec, "x"));
			chunks.push(paxData);
			const paxPad = padToBlock(paxData.length);
			if (paxPad) chunks.push(paxPad);
		}

		// Fallback ASCII-safe short name in ustar header (overridden by PAX when needed)
		const fallbackName = needsPax ? `entry_${seen.size}` : relPath;
		chunks.push(buildHeaderBlock(fallbackName, bytes.length, mtimeSec, "0"));
		chunks.push(bytes);
		const pad = padToBlock(bytes.length);
		if (pad) chunks.push(pad);
	}

	// Two 512-byte zero blocks terminate a tar archive.
	chunks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
	return zlib.gzipSync(Buffer.concat(chunks), { level: 6 });
}

export function unpackTarGz(gzBytes: Buffer, opts: UnpackTarOptions = {}): TarEntry[] {
	const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

	let tarBuf: Buffer;
	try {
		tarBuf = zlib.gunzipSync(gzBytes, { maxOutputLength: maxTotalBytes + BLOCK_SIZE * 4096 });
	} catch (err) {
		throw new Error(`Invalid or oversized backup archive: ${err instanceof Error ? err.message : String(err)}`);
	}

	const entries: TarEntry[] = [];
	const seen = new Set<string>();
	let totalBytes = 0;
	let offset = 0;
	let nextPax: Record<string, string> | null = null;

	while (offset + BLOCK_SIZE <= tarBuf.length) {
		const header = tarBuf.subarray(offset, offset + BLOCK_SIZE);
		offset += BLOCK_SIZE;

		// End-of-archive zero block check
		let allZero = true;
		for (let i = 0; i < BLOCK_SIZE; i++) {
			if (header[i] !== 0) {
				allZero = false;
				break;
			}
		}
		if (allZero) break;

		const storedChecksum = parseOctal(header, 148, 8);
		let computed = 0;
		for (let i = 0; i < BLOCK_SIZE; i++) {
			computed += i >= 148 && i < 156 ? 0x20 : header[i]!;
		}
		if (!Number.isFinite(storedChecksum) || storedChecksum !== computed) {
			throw new Error("Corrupt backup archive header checksum.");
		}

		const size = parseOctal(header, 124, 12);
		if (!Number.isFinite(size) || size < 0 || offset + size > tarBuf.length) {
			throw new Error("Corrupt backup archive entry size.");
		}

		const mtimeSec = parseOctal(header, 136, 12);
		const typeflag = String.fromCharCode(header[156] || 0x30);
		const data = Buffer.from(tarBuf.subarray(offset, offset + size));
		offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

		if (typeflag === "x") {
			nextPax = parsePaxRecords(data);
			continue;
		}
		if (typeflag === "g") {
			continue; // global PAX header
		}
		if (typeflag === "5") {
			nextPax = null;
			continue; // directory entry
		}
		if (typeflag !== "0" && typeflag !== "\0") {
			throw new Error(`Unsupported tar entry type "${typeflag}" in backup archive (symlinks/special files are rejected).`);
		}

		const rawName = readCString(header, 0, 100);
		const rawPrefix = readCString(header, 345, 155);
		const combined = nextPax?.path ?? (rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
		nextPax = null;

		const normalized = combined.replace(/^\.\//, "");
		if (!isValidBundleRelativePath(normalized)) {
			throw new Error(`Unsafe path in backup archive: ${combined}`);
		}
		if (seen.has(normalized)) {
			throw new Error(`Duplicate path in backup archive: ${normalized}`);
		}
		seen.add(normalized);

		totalBytes += data.length;
		if (entries.length + 1 > maxEntries) {
			throw new Error(`Backup archive exceeds maximum entry limit (${maxEntries}).`);
		}
		if (totalBytes > maxTotalBytes) {
			throw new Error(`Backup archive exceeds maximum uncompressed size (${Math.round(maxTotalBytes / (1024 * 1024))} MiB).`);
		}

		entries.push({
			path: normalized,
			bytes: data,
			mtimeMs: Number.isFinite(mtimeSec) && mtimeSec > 0 ? mtimeSec * 1000 : undefined,
		});
	}

	return entries;
}
