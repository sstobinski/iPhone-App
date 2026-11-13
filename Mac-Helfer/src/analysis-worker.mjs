import { parentPort } from 'node:worker_threads';
import jpeg from '../vendor/jpeg-js/index.js';
import { inspectWindowJpeg } from './jpeg.mjs';
import { detectWaveformRegion } from './layout-detector.mjs';
import { detectPlatterRegions } from './platter-layout.mjs';

parentPort.on('message', value => {
  const id = value?.id;
  try {
    const bytes = Buffer.from(value.bytes);
    const dimensions = inspectWindowJpeg(bytes);
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true,
      tolerantDecoding: false, maxResolutionInMP: 8, maxMemoryUsageInMB: 64 });
    if (image.width !== dimensions.width || image.height !== dimensions.height) throw new Error();
    const result = detectWaveformRegion(image, value.previousRegion);
    if (result.status === 'recognized') result.platters = detectPlatterRegions(image, result.crop);
    parentPort.postMessage({ id, result });
  } catch {
    parentPort.postMessage({ id, errorCode: 'CAPTURE_ANALYSIS_INVALID' });
  }
});
