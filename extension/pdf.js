/* Small image-only PDF 1.4 writer. Lossless RGB + FlateDecode, no remote library. */
(() => {
  'use strict';
  const PDF = globalThis.CSPDF ||= {};
  if (PDF.RasterPDF) return;
  const encoder = new TextEncoder();
  const bytes = value => typeof value === 'string' ? encoder.encode(value) : value;
  const join = chunks => {
    const result = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  };
  PDF.RasterPDF = class RasterPDF {
    constructor() { this.pages = []; this.total = 0; }
    async addPage(canvas) {
      if (this.pages.length >= 200) throw new Error('超过单次 200 页限制，请分批导出。');
      const context = canvas.getContext('2d', {willReadFrequently: true});
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const rgb = new Uint8Array(canvas.width * canvas.height * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4) { rgb[j++] = rgba[i]; rgb[j++] = rgba[i+1]; rgb[j++] = rgba[i+2]; }
      const stream = new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'));
      const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
      this.total += compressed.length;
      if (this.total > 256 * 1024 * 1024) throw new Error('PDF 超过单次 256 MB 限制，请分批导出。');
      this.pages.push({width: canvas.width, height: canvas.height, data: compressed});
    }
    blob() {
      if (!this.pages.length) throw new Error('没有可导出的页面。');
      const objects = [null, bytes('<< /Type /Catalog /Pages 2 0 R >>'), null];
      const references = [];
      for (const image of this.pages) {
        const pageId = objects.length, contentId = pageId + 1, imageId = pageId + 2;
        references.push(`${pageId} 0 R`);
        objects.push(bytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.276 841.89] /Resources << /XObject << /Im ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
        const drawing = bytes('q\n538.583 0 0 785.197 28.346 28.346 cm\n/Im Do\nQ\n');
        objects.push(join([bytes(`<< /Length ${drawing.length} >>\nstream\n`), drawing, bytes('endstream')]));
        objects.push(join([bytes(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.data.length} >>\nstream\n`), image.data, bytes('\nendstream')]));
      }
      objects[2] = bytes(`<< /Type /Pages /Count ${references.length} /Kids [${references.join(' ')}] >>`);
      const parts = [bytes('%PDF-1.4\n%'), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 10])], offsets = [0];
      let size = parts.reduce((n, part) => n + part.length, 0);
      for (let id = 1; id < objects.length; id++) {
        offsets.push(size);
        const object = join([bytes(`${id} 0 obj\n`), objects[id], bytes('\nendobj\n')]); parts.push(object); size += object.length;
      }
      const xref = size;
      parts.push(bytes(`xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
      return new Blob(parts, {type: 'application/pdf'});
    }
  };
})();
