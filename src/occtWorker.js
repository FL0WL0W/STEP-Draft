import { createStepFaceProcessor } from './occtPipeline.js';

let processorPromise = null;

self.addEventListener('message', async (event) => {
  const message = event.data || {};

  try {
    if (message.type === 'init') {
      processorPromise = createStepFaceProcessor(message.buffer, {
        rotation: message.rotation
      });
      await processorPromise;
      self.postMessage({ type: 'ready' });
      return;
    }

    if (message.type === 'process-face') {
      if (!processorPromise) {
        throw new Error('OCCT worker received a face job before initialization.');
      }

      const processor = await processorPromise;
      const result = processor.processFace(message.faceIndex, message.draftAngleDegrees);

      self.postMessage({
        ...result,
        jobId: message.jobId,
        type: 'result'
      });
      return;
    }

    if (message.type === 'idle') {
      return;
    }
  } catch (error) {
    self.postMessage({
      error: error.message || String(error),
      stack: error.stack || null,
      type: 'error'
    });
  }
});
