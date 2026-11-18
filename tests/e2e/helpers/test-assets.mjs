import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const typeBuf = Buffer.from(type, "ascii");
	const lenBuf = Buffer.allocUnsafe(4);
	lenBuf.writeUInt32BE(data.length, 0);
	const crcInput = Buffer.concat([typeBuf, data]);
	const crcBuf = Buffer.allocUnsafe(4);
	crcBuf.writeUInt32BE(crc32(crcInput), 0);
	return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Zero-dependency RGBA PNG builder.
 * @param {{ width: number, height: number, background?: [number, number, number, number?], draw?: (ctx: { width: number, height: number, setPixel: (x: number, y: number, rgba: number[]) => void, fillRect: (x: number, y: number, w: number, h: number, rgba: number[]) => void, drawLine: (x0: number, y0: number, x1: number, y1: number, rgba: number[], thickness?: number) => void }) => void }} options
 * @returns {Buffer}
 */
export function buildPng({ width, height, background = [255, 255, 255, 255], draw } = {}) {
	if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
		throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
	}
	const bg = [
		background[0] ?? 255,
		background[1] ?? 255,
		background[2] ?? 255,
		background[3] ?? 255,
	];
	const pixels = Buffer.allocUnsafe(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		const off = i * 4;
		pixels[off] = bg[0];
		pixels[off + 1] = bg[1];
		pixels[off + 2] = bg[2];
		pixels[off + 3] = bg[3];
	}

	const setPixel = (x, y, rgba) => {
		const ix = Math.round(x);
		const iy = Math.round(y);
		if (ix < 0 || ix >= width || iy < 0 || iy >= height) return;
		const off = (iy * width + ix) * 4;
		pixels[off] = rgba[0] ?? 0;
		pixels[off + 1] = rgba[1] ?? 0;
		pixels[off + 2] = rgba[2] ?? 0;
		pixels[off + 3] = rgba[3] ?? 255;
	};

	const fillRect = (rx, ry, rw, rh, rgba) => {
		const xStart = Math.max(0, Math.floor(rx));
		const yStart = Math.max(0, Math.floor(ry));
		const xEnd = Math.min(width, Math.ceil(rx + rw));
		const yEnd = Math.min(height, Math.ceil(ry + rh));
		for (let y = yStart; y < yEnd; y++) {
			for (let x = xStart; x < xEnd; x++) {
				setPixel(x, y, rgba);
			}
		}
	};

	const drawLine = (x0, y0, x1, y1, rgba, thickness = 1) => {
		const dx = x1 - x0;
		const dy = y1 - y0;
		const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
		const half = Math.floor(thickness / 2);
		for (let i = 0; i <= steps; i++) {
			const cx = Math.round(x0 + (dx * i) / steps);
			const cy = Math.round(y0 + (dy * i) / steps);
			for (let oy = -half; oy <= half; oy++) {
				for (let ox = -half; ox <= half; ox++) {
					setPixel(cx + ox, cy + oy, rgba);
				}
			}
		}
	};

	if (typeof draw === "function") {
		draw({ width, height, setPixel, fillRect, drawLine });
	}

	const stride = width * 4;
	const raw = Buffer.allocUnsafe((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		const rowStart = y * (stride + 1);
		raw[rowStart] = 0; // filter None
		pixels.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
	}

	const ihdr = Buffer.allocUnsafe(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	ihdr[10] = 0; // compression
	ihdr[11] = 0; // filter
	ihdr[12] = 0; // interlace

	const idat = zlib.deflateSync(raw);
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", idat),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

export function createSolidPng(width = 16, height = 16, rgba = [30, 64, 175, 255]) {
	return buildPng({ width, height, background: rgba });
}

export function createVectorDiagramPng(width = 160, height = 120) {
	return buildPng({
		width,
		height,
		background: [255, 255, 255, 255],
		draw: ({ fillRect, drawLine }) => {
			// Axes
			drawLine(20, height - 20, width - 16, height - 20, [30, 41, 59, 255], 2);
			drawLine(20, height - 20, 20, 16, [30, 41, 59, 255], 2);
			// Velocity vector (blue) + components (red/emerald)
			drawLine(20, height - 20, width - 30, 24, [29, 78, 216, 255], 3);
			drawLine(20, height - 20, width - 30, height - 20, [220, 38, 38, 255], 2);
			drawLine(width - 30, height - 20, width - 30, 24, [5, 150, 105, 255], 2);
			fillRect(width - 34, 20, 8, 8, [29, 78, 216, 255]);
		},
	});
}

function paethPredictor(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

function srgbToRelativeLuminance(r, g, b) {
	const toLinear = (c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function srgbLuminance255(r, g, b) {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Decode PNG IDAT pixels and measure background luminance, stroke pixel count,
 * and WCAG contrast ratio without external libraries.
 */
export function analyzePngPixels(pngBuffer) {
	const buf = Buffer.isBuffer(pngBuffer) ? pngBuffer : Buffer.from(pngBuffer);
	if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
		throw new Error("Input is not a valid PNG signature");
	}

	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	let palette = null;
	const idatChunks = [];

	while (offset + 12 <= buf.length) {
		const len = buf.readUInt32BE(offset);
		const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
		const dataStart = offset + 8;
		const dataEnd = dataStart + len;
		if (dataEnd + 4 > buf.length) {
			throw new Error(`Truncated PNG chunk ${type}`);
		}
		const data = buf.subarray(dataStart, dataEnd);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8];
			colorType = data[9];
			interlace = data[12];
		} else if (type === "PLTE") {
			palette = data;
		} else if (type === "IDAT") {
			idatChunks.push(data);
		} else if (type === "IEND") {
			break;
		}
		offset = dataEnd + 4;
	}

	if (!width || !height) {
		throw new Error("Missing or invalid PNG IHDR chunk");
	}
	if (bitDepth !== 8) {
		throw new Error(`Unsupported PNG bit depth: ${bitDepth} (expected 8)`);
	}
	if (interlace !== 0) {
		throw new Error(`Unsupported interlaced PNG (interlace=${interlace})`);
	}

	const bytesPerPixelMap = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
	const bpp = bytesPerPixelMap[colorType];
	if (!bpp) {
		throw new Error(`Unsupported PNG color type: ${colorType}`);
	}

	const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
	const rowBytes = width * bpp;
	if (inflated.length < (rowBytes + 1) * height) {
		throw new Error("PNG IDAT data shorter than expected scanlines");
	}

	const unfiltered = Buffer.allocUnsafe(rowBytes * height);
	for (let y = 0; y < height; y++) {
		const srcRow = y * (rowBytes + 1);
		const filter = inflated[srcRow];
		const dstRow = y * rowBytes;
		for (let x = 0; x < rowBytes; x++) {
			const rawByte = inflated[srcRow + 1 + x];
			const a = x >= bpp ? unfiltered[dstRow + x - bpp] : 0;
			const b = y > 0 ? unfiltered[dstRow - rowBytes + x] : 0;
			const c = y > 0 && x >= bpp ? unfiltered[dstRow - rowBytes + x - bpp] : 0;
			let val;
			switch (filter) {
				case 0:
					val = rawByte;
					break;
				case 1:
					val = (rawByte + a) & 0xff;
					break;
				case 2:
					val = (rawByte + b) & 0xff;
					break;
				case 3:
					val = (rawByte + ((a + b) >> 1)) & 0xff;
					break;
				case 4:
					val = (rawByte + paethPredictor(a, b, c)) & 0xff;
					break;
				default:
					throw new Error(`Unknown PNG scanline filter type: ${filter}`);
			}
			unfiltered[dstRow + x] = val;
		}
	}

	const totalPixels = width * height;
	const rgbaPixels = new Uint8Array(totalPixels * 4);
	const colorCounts = new Map();
	let transparentPixelCount = 0;

	for (let i = 0; i < totalPixels; i++) {
		const src = i * bpp;
		let r = 0;
		let g = 0;
		let b = 0;
		let a = 255;
		if (colorType === 6) {
			r = unfiltered[src];
			g = unfiltered[src + 1];
			b = unfiltered[src + 2];
			a = unfiltered[src + 3];
		} else if (colorType === 2) {
			r = unfiltered[src];
			g = unfiltered[src + 1];
			b = unfiltered[src + 2];
		} else if (colorType === 0) {
			r = g = b = unfiltered[src];
		} else if (colorType === 4) {
			r = g = b = unfiltered[src];
			a = unfiltered[src + 1];
		} else if (colorType === 3) {
			const idx = unfiltered[src] * 3;
			if (!palette || idx + 2 >= palette.length) {
				throw new Error("Indexed PNG missing palette entry");
			}
			r = palette[idx];
			g = palette[idx + 1];
			b = palette[idx + 2];
		}

		const dst = i * 4;
		rgbaPixels[dst] = r;
		rgbaPixels[dst + 1] = g;
		rgbaPixels[dst + 2] = b;
		rgbaPixels[dst + 3] = a;

		if (a < 20) {
			transparentPixelCount++;
		}
		const key = `${r},${g},${b},${a}`;
		colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
	}

	// Determine background from most frequent color (quantized exact match)
	let bgKey = "255,255,255,255";
	let bestCount = -1;
	for (const [key, count] of colorCounts.entries()) {
		if (count > bestCount) {
			bestCount = count;
			bgKey = key;
		}
	}
	const [bgR, bgG, bgB, bgA] = bgKey.split(",").map(Number);
	const backgroundLuminance = srgbLuminance255(bgR, bgG, bgB);
	const bgRelLum = srgbToRelativeLuminance(bgR, bgG, bgB);

	let strokePixelCount = 0;
	let maxContrastRatio = 1;
	let strokeLumSum = 0;
	let strokeContrastSum = 0;
	const strokeContrastRatios = [];

	for (let i = 0; i < totalPixels; i++) {
		const dst = i * 4;
		const rawR = rgbaPixels[dst];
		const rawG = rgbaPixels[dst + 1];
		const rawB = rgbaPixels[dst + 2];
		const a = rgbaPixels[dst + 3];
		if (a < 20) continue;
		const alpha = a / 255;
		const r = a === 255 ? rawR : Math.round(rawR * alpha + bgR * (1 - alpha));
		const g = a === 255 ? rawG : Math.round(rawG * alpha + bgG * (1 - alpha));
		const b = a === 255 ? rawB : Math.round(rawB * alpha + bgB * (1 - alpha));
		const dist = Math.hypot(r - bgR, g - bgG, b - bgB);
		if (dist > 30) {
			strokePixelCount++;
			strokeLumSum += srgbLuminance255(r, g, b);
			const relLum = srgbToRelativeLuminance(r, g, b);
			const l1 = Math.max(bgRelLum, relLum);
			const l2 = Math.min(bgRelLum, relLum);
			const ratio = (l1 + 0.05) / (l2 + 0.05);
			if (ratio > maxContrastRatio) maxContrastRatio = ratio;
			strokeContrastSum += ratio;
			strokeContrastRatios.push(ratio);
		}
	}

	return {
		width,
		height,
		bitDepth,
		colorType,
		totalPixels,
		transparentPixelCount,
		backgroundColor: [bgR, bgG, bgB, bgA],
		backgroundLuminance,
		strokePixelCount,
		meanStrokeLuminance: strokePixelCount > 0 ? strokeLumSum / strokePixelCount : backgroundLuminance,
		meanContrastRatio: strokePixelCount > 0 ? strokeContrastSum / strokePixelCount : 1,
		maxContrastRatio,
		strokeContrastRatios,
	};
}

export function assertPngContrast(
	pngBuffer,
	{ expectedBackground = "light", minStrokePixels = 10, minContrastRatio = 3.0 } = {},
) {
	const stats = analyzePngPixels(pngBuffer);
	if (stats.transparentPixelCount > 0 && stats.backgroundColor[3] < 20) {
		throw new Error(`Exported PNG has transparent background (${stats.transparentPixelCount} transparent pixels)`);
	}
	if (expectedBackground === "light" && stats.backgroundLuminance < 200) {
		throw new Error(
			`Expected light PNG background (>=200 luminance), got ${stats.backgroundLuminance.toFixed(1)} (${stats.backgroundColor.join(",")})`,
		);
	}
	if (expectedBackground === "dark" && stats.backgroundLuminance > 70) {
		throw new Error(
			`Expected dark PNG background (<=70 luminance), got ${stats.backgroundLuminance.toFixed(1)} (${stats.backgroundColor.join(",")})`,
		);
	}
	if (stats.strokePixelCount < minStrokePixels) {
		throw new Error(`Expected >=${minStrokePixels} stroke pixels, got ${stats.strokePixelCount}`);
	}
	const qualifyingStrokePixels = stats.strokeContrastRatios.filter((ratio) => ratio >= minContrastRatio).length;
	if (qualifyingStrokePixels < minStrokePixels) {
		throw new Error(
			`Expected >=${minStrokePixels} stroke pixels with WCAG contrast >=${minContrastRatio}, got ${qualifyingStrokePixels} (mean=${stats.meanContrastRatio.toFixed(2)}, max=${stats.maxContrastRatio.toFixed(2)})`,
		);
	}
	return { ...stats, qualifyingStrokePixels };
}

function escapePdfString(text) {
	return String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Zero-dependency valid multi-page PDF builder with exact xref offsets.
 * @param {string[]} pageTexts
 * @returns {Buffer}
 */
export function buildPdfFromPages(pageTexts) {
	if (!Array.isArray(pageTexts) || pageTexts.length === 0) {
		throw new Error("buildPdfFromPages requires at least one page");
	}
	const pageCount = pageTexts.length;
	const fontObjId = 3 + pageCount * 2;
	const objects = [];

	// 1: Catalog
	objects.push({ id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" });

	// 2: Pages
	const kidRefs = [];
	for (let i = 0; i < pageCount; i++) {
		kidRefs.push(`${3 + i * 2} 0 R`);
	}
	objects.push({
		id: 2,
		body: `<< /Type /Pages /Kids [${kidRefs.join(" ")}] /Count ${pageCount} >>`,
	});

	// Page & Content stream pairs
	for (let i = 0; i < pageCount; i++) {
		const pageObjId = 3 + i * 2;
		const contentObjId = pageObjId + 1;
		const lines = String(pageTexts[i]).split(/\r?\n/);
		const streamLines = ["BT", "/F1 12 Tf", "72 720 Td", "16 TL"];
		for (let l = 0; l < lines.length; l++) {
			const prefix = l === 0 ? "" : "T* ";
			streamLines.push(`${prefix}(${escapePdfString(lines[l])}) Tj`);
		}
		streamLines.push("ET");
		const streamContent = `${streamLines.join("\n")}\n`;
		const streamBytes = Buffer.byteLength(streamContent, "utf8");

		objects.push({
			id: pageObjId,
			body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>`,
		});
		objects.push({
			id: contentObjId,
			body: `<< /Length ${streamBytes} >>\nstream\n${streamContent}endstream`,
		});
	}

	// Font object
	objects.push({
		id: fontObjId,
		body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	});

	objects.sort((a, b) => a.id - b.id);

	const chunks = [Buffer.from("%PDF-1.4\n", "ascii")];
	let byteOffset = chunks[0].length;
	const offsets = [0]; // obj 0

	for (const obj of objects) {
		offsets[obj.id] = byteOffset;
		const serialized = `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
		const buf = Buffer.from(serialized, "utf8");
		chunks.push(buf);
		byteOffset += buf.length;
	}

	const xrefStart = byteOffset;
	const xrefLines = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
	for (let id = 1; id <= objects.length; id++) {
		xrefLines.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
	}
	const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
	chunks.push(Buffer.from(xrefLines.join("") + trailer, "ascii"));
	return Buffer.concat(chunks);
}

export function buildSample3PagePdf() {
	return buildPdfFromPages([
		"Kinematics Study Sheet - Page 1\nPosition x(t) and instantaneous velocity v(t) = dx/dt.",
		"Kinematics Study Sheet - Page 2\nProjectile trajectory equation y = x*tan(theta) - g*x^2 / (2*v0^2*cos^2(theta)).",
		"Kinematics Study Sheet - Page 3\nHorizontal range R = v0^2*sin(2*theta)/g and energy conservation summary.",
	]);
}
