import { callAny, enumValue, makeInstance, statusValue } from './occtRuntime.js';

function transferReaderRoots(oc, reader) {
  const progress = makeInstance(oc, 'Message_ProgressRange');
  const attempts = [
    () => reader.TransferRoots(progress),
    () => reader.TransferRoot(1, progress),
    () => {
      const rootCount = reader.NbRootsForTransfer();
      let transferred = 0;

      for (let rootIndex = 1; rootIndex <= rootCount; rootIndex += 1) {
        transferred += reader.TransferOneRoot(rootIndex, progress) ? 1 : 0;
      }

      return transferred;
    }
  ];
  const errors = [];

  for (const attempt of attempts) {
    try {
      const transferred = attempt();

      if (typeof transferred === 'number' || typeof transferred === 'boolean') {
        return transferred;
      }
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  throw new Error(`OpenCascade could read the STEP file but could not transfer roots: ${errors.join(' | ')}`);
}

export function readStepShape(oc, buffer) {
  const path = `/tmp/model-${Date.now()}.step`;
  oc.FS.writeFile(path, new Uint8Array(buffer));

  if (oc.STEPControl_Controller?.Init) {
    oc.STEPControl_Controller.Init();
  }

  const reader = makeInstance(oc, 'STEPControl_Reader');
  const status = statusValue(callAny(reader, ['ReadFile'], [path]));

  const knownFailureStatuses = new Set([
    2,
    3,
    4
  ]);

  if (knownFailureStatuses.has(status)) {
    throw new Error(`OpenCascade could not read this STEP file. ReadFile status: ${status}`);
  }

  const transferred = transferReaderRoots(oc, reader);
  const shape = callAny(reader, ['OneShape']);

  if (callAny(shape, ['IsNull'])) {
    throw new Error(`OpenCascade read the file but produced an empty shape. ReadFile status: ${status}, transferred roots: ${transferred}`);
  }

  return shape;
}

export function writeStepShape(oc, shape) {
  const writer = makeInstance(oc, 'STEPControl_Writer');
  const path = `/tmp/split-model-${Date.now()}.step`;
  const progress = makeInstance(oc, 'Message_ProgressRange');
  const mode = enumValue(oc, 'STEPControl_StepModelType', 'STEPControl_AsIs');
  const enumDoneStatus = statusValue(enumValue(oc, 'IFSelect_ReturnStatus', 'IFSelect_RetDone'));
  const doneStatus = Number.isFinite(enumDoneStatus) ? enumDoneStatus : 1;
  const transferStatus = statusValue(callAny(writer, ['Transfer'], [shape, mode, true, progress]));

  if (transferStatus !== doneStatus) {
    throw new Error(`OpenCascade could not transfer the split shape for STEP export. Transfer status: ${transferStatus}`);
  }

  const writeStatus = statusValue(callAny(writer, ['Write'], [path]));

  if (writeStatus !== doneStatus) {
    throw new Error(`OpenCascade could not write the split STEP file. Write status: ${writeStatus}`);
  }

  return oc.FS.readFile(path, { encoding: 'utf8' });
}

function uniqueTempPath(prefix, extension) {
  const random = Math.random().toString(36).slice(2);
  return `/tmp/${prefix}-${Date.now()}-${random}.${extension}`;
}

export function writeBrepShape(oc, shape) {
  const path = uniqueTempPath('shape', 'brep');
  const progress = makeInstance(oc, 'Message_ProgressRange');
  const ok = callAny(oc.BRepTools, ['Write'], [shape, path, progress]);

  if (!ok) {
    throw new Error('OpenCascade could not serialize replacement face to BREP.');
  }

  return oc.FS.readFile(path, { encoding: 'utf8' });
}

export function readBrepShape(oc, brepText) {
  const path = uniqueTempPath('replacement', 'brep');
  const shape = makeInstance(oc, 'TopoDS_Shape');
  const builder = makeInstance(oc, 'BRep_Builder');
  const progress = makeInstance(oc, 'Message_ProgressRange');

  oc.FS.writeFile(path, brepText);

  const ok = callAny(oc.BRepTools, ['Read'], [shape, path, builder, progress]);

  if (!ok || callAny(shape, ['IsNull'])) {
    throw new Error('OpenCascade could not read replacement BREP from worker.');
  }

  return shape;
}
