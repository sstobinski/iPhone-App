import qrcode from '../vendor/qrcode-generator/qrcode.js';

export function createConnectionQr(url) {
  const code = qrcode(0, 'M');
  code.addData(url, 'Byte');
  code.make();
  return code.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
}
