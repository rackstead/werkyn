import sharp from "sharp";

export const png = await sharp({
  create: { width: 2, height: 2, channels: 3, background: "#33aa77" },
})
  .png()
  .toBuffer();

export const webp = await sharp(png).webp().toBuffer();

export function makePdf() {
  const stream = "BT /F1 22 Tf 24 100 Td (SEC017 passive PDF) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 280 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  document += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  document += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

export function makeWave() {
  const samples = 800;
  const wave = Buffer.alloc(44 + samples * 2);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(samples * 2, 40);
  return wave;
}

// Four locally generated 32px canvas frames, encoded as VP8/WebM by Chromium.
export const webm = Buffer.from(
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAI6EU2bdLlNu4tTq4QVSalmU6yBbk27i1OrhBZUrmtTrIGTTbuLU6uEH0O2dVOsgcFNu4xTq4QcU7trU6yCAijsrgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBEiYRDlj3TTYCGQ2hyb21lV0GGQ2hyb21lFlSua6mup9eBAXPFh3Z5tH/cNkODgQFV7oEBhoVWX1ZQOOCKsIEguoEgU8CBAR9DtnUBAAAAAAABW+eBAKDlobiBAAAAsAIAnQEqIAAgAAAHCIWFiJmEiAEkEBOtUBA/yK7zAP7E79d4tKNf/vkD/75A/++QP/e/4HWhqKam7oEBpaFQAgCdASogACAAAAcIhYWImYSIASQQADyHnk4A/v+6gwCg0qGxgQBkAHECAAAQCSAAwDpAf0BBC9OWagHX+AD+9hNf/z2Ywd5//z2j/9AGObgj/8+oAHWhmaaX7oEBpZLRAQAAEAkgAMAAwsF/oABDgAD7gQCgy6GqgQDIAPEBAAAQCSAAwADyv6BgAag4AP7E79dYsKlh9b/98f36DaZ/3v+AdaGZppfugQGlktEBAAAQCSAAwADCwX+gAEOAAPuBZKDOoa2BASwA8QEAABAJIADAAPK/oGABqDgA/vYTX/89mMHef/89o//QBjm4I//PqAB1oZmml+6BAaWS0QEAABAJIADAAMLBf6AAQ4AA+4HIHFO7a427i7OBALeG94EB8YHB",
  "base64",
);
